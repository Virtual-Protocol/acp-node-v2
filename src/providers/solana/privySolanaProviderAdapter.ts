import {
  createSolanaRpc,
  createSolanaRpcFromTransport,
  createSignableMessage,
  getBase58Decoder,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionEncoder,
  addSignersToTransactionMessage,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  type Address,
  type Rpc,
  type Signature,
  type Slot,
  type SolanaRpcApi,
} from "@solana/kit";
import type { SolanaCluster } from "../../core/chains.js";
import type {
  SendInstructionsOptions,
  SolanaInstructionLike,
  SolanaSigner,
} from "../types.js";
import { SolanaProviderAdapter } from "./solanaProviderAdapter.js";
import {
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
  type WalletApiRequestSignatureInput,
} from "@privy-io/node";
import {
  ACP_SERVER_URL,
  PRIVY_APP_ID,
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_CHAIN_ID_CLUSTERS,
} from "../../core/constants.js";
import { ProviderAuthClient } from "../providerAuthClient.js";
import {
  ApprovalRequiredError,
  awaitApproval,
} from "../../core/approvalGate.js";
import { withFeePayerRetry } from "./feePayerRetry.js";
import { stringifyBigIntSafe } from "../../core/solana/serialization.js";
import {
  SOLANA_ACP_PROGRAM_ID,
  SOLANA_FUND_TRANSFER_HOOK_PROGRAM_ID,
} from "../../core/constants.js";

const SPONSORABLE_PROGRAM_IDS: ReadonlySet<string> = new Set([
  SOLANA_ACP_PROGRAM_ID,
  SOLANA_FUND_TRANSFER_HOOK_PROGRAM_ID,
]);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type SignFn = (payload: Uint8Array) => Promise<string>;

export interface PrivySolanaConfig {
  walletAddress: string;
  walletId: string;
  signerPrivateKey?: string;
  signFn?: SignFn;
  /** Solana chain ID (500 = devnet, 501 = mainnet). Defaults to devnet. */
  chainId?: number;
  /** Explicit RPC URL. When set, bypasses the ACP server proxy. */
  rpcUrl?: string;
  serverUrl?: string;
  privyAppId?: string;
  sponsored?: boolean;
  /**
   * Called when a sponsored send is retried due to sponsor-node lag.
   * When provided, replaces the default one-line console notice. `slot` is
   * the read RPC's slot at blockhash fetch, `requiredSlot` is the slot in
   * which the required account state was created (the slot the sponsor node
   * must reach), `nodeSlot` is the lagging node's own slot when the error
   * exposes it (only -32016 minimum-context-slot errors do; Alchemy
   * simulation errors leave it null), and `rawError` carries the underlying
   * simulation failure for debugging.
   */
  onSponsoredRetry?: (info: {
    attempt: number;
    maxAttempts: number;
    slot: bigint | null;
    requiredSlot: bigint | null;
    nodeSlot: bigint | null;
    rawError: string;
  }) => void;
}

function maxSlot(a: bigint | null, b: bigint | null): bigint | null {
  if (a == null) return b;
  if (b == null) return a;
  return a > b ? a : b;
}

// Extracts the responding node's slot from an error chain. Only the
// broadcast-side -32016 "minimum context slot not reached" error carries it
// (as `contextSlot` on the SolanaError context); Alchemy's sponsorship
// simulation errors report no slot.
export function extractNodeContextSlot(err: unknown): bigint | null {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 6; depth++) {
    const context = (current as { context?: Record<string, unknown> }).context;
    const raw = context?.contextSlot;
    if (typeof raw === "bigint" || typeof raw === "number") {
      return BigInt(raw);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Resolves the two slots reported when a sponsored attempt is retried:
 *   - `nodeSlot`: the responding node's slot, present only on a -32016
 *     broadcast error (see extractNodeContextSlot).
 *   - `requiredSlot`: the slot the failing step needed to reach. For a -32016
 *     broadcast error this is the exact `minContextSlot` we sent
 *     (`max(simulationSlot, lastConfirmedSlot)`), captured as
 *     `lastMinContextSlot`, so `requiredSlot - nodeSlot` is guaranteed
 *     positive. When the attempt failed before broadcast (sponsor-simulation
 *     lag throws a plain error with no slot), it falls back to the last
 *     confirmed slot, then to our read RPC's blockhash slot — the required
 *     state is visible by that slot, so it is a valid sync target.
 */
export function resolveSponsoredRetrySlots(
  error: unknown,
  slots: {
    lastMinContextSlot: bigint | null;
    lastConfirmedSlot: bigint | null;
    lastSeenSlot: bigint | null;
  },
): { requiredSlot: bigint | null; nodeSlot: bigint | null } {
  return {
    nodeSlot: extractNodeContextSlot(error),
    requiredSlot:
      slots.lastMinContextSlot ??
      slots.lastConfirmedSlot ??
      slots.lastSeenSlot,
  };
}

/** Human-readable warning for a sponsored-transaction retry. */
export function formatSponsoredRetryWarning(
  requiredSlot: bigint | null,
  nodeSlot: bigint | null,
  attempt: number,
  maxAttempts: number,
): string {
  const gap =
    requiredSlot != null && nodeSlot != null ? requiredSlot - nodeSlot : null;
  return gap != null && gap > 0n
    ? `[PrivySolana] sponsor node ${gap} slot${gap === 1n ? "" : "s"} behind required slot ${requiredSlot} (attempt ${attempt}/${maxAttempts})`
    : requiredSlot != null
      ? `[PrivySolana] waiting for sponsor node to reach slot ${requiredSlot} (attempt ${attempt}/${maxAttempts})`
      : `[PrivySolana] sponsor node syncing, waiting (attempt ${attempt}/${maxAttempts})`;
}

// ---------------------------------------------------------------------------
// Privy auth helpers (same pattern as PrivyAlchemyEvmProviderAdapter)
// ---------------------------------------------------------------------------

function buildSignInput(
  walletId: string,
  body: Record<string, unknown>,
  privyAppId: string,
): WalletApiRequestSignatureInput {
  return {
    version: 1,
    method: "POST",
    url: `https://api.privy.io/v1/wallets/${walletId}/rpc`,
    body,
    headers: { "privy-app-id": privyAppId },
  };
}

async function serverPost<T>(
  path: string,
  body: unknown,
  serverUrl: string,
): Promise<T> {
  const base = serverUrl.replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const payload = (data as any)?.code ? data : (data as any)?.message;
    if (res.status === 403 && payload?.code === "APPROVAL_REQUIRED") {
      const approvalId = payload.details?.approvalId ?? "";
      const approvalUrl = payload.details?.approvalUrl ?? "";
      const detail = payload.detail ?? "Manual approval required";
      console.error(
        `[PrivySolana] Manual approval required.\n` +
          `  Approve at: ${approvalUrl}\n` +
          `  Approval ID: ${approvalId}\n` +
          `  Reason: ${detail}`,
      );
      throw new ApprovalRequiredError(approvalId, approvalUrl, detail);
    }
    throw new Error(
      (data as any)?.detail ??
        (data as any)?.error ??
        `Server error ${res.status}`,
    );
  }
  return data as T;
}

function generatePrivyAuthSig(
  walletId: string,
  rpcBody: Record<string, unknown>,
  signerPrivateKey: string | undefined,
  privyAppId: string,
  signFn?: SignFn,
): string | Promise<string> {
  const input = buildSignInput(walletId, rpcBody, privyAppId);
  if (signFn) {
    const formatted = formatRequestForAuthorizationSignature(input);
    return signFn(formatted);
  }
  if (signerPrivateKey) {
    return generateAuthorizationSignature({
      authorizationPrivateKey: signerPrivateKey,
      input,
    });
  }
  throw new Error(
    "PrivySolanaProviderAdapter: either signerPrivateKey or signFn must be provided",
  );
}

async function signedServerCall<T>(
  executePath: string,
  walletId: string,
  rpcBody: Record<string, unknown>,
  payload: Record<string, unknown>,
  signerPrivateKey: string | undefined,
  serverUrl: string,
  privyAppId: string,
  signFn?: SignFn,
): Promise<T> {
  const authorizationSignature = await generatePrivyAuthSig(
    walletId,
    rpcBody,
    signerPrivateKey,
    privyAppId,
    signFn,
  );
  try {
    return await serverPost<T>(
      executePath,
      { ...payload, authorizationSignature },
      serverUrl,
    );
  } catch (err) {
    if (err instanceof ApprovalRequiredError) {
      const result = await awaitApproval<T>(err.approvalId);
      if (result === undefined) {
        throw new Error(
          `Approval ${err.approvalId} resolved as approved but no result payload was provided`,
        );
      }
      return result;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Wire format helpers
// ---------------------------------------------------------------------------

function buildUnsignedWireBytes(
  messageBytes: Uint8Array,
  signatures: Record<string, Uint8Array | null>,
): Uint8Array {
  const sigEntries = Object.entries(signatures);
  const numSigs = sigEntries.length;
  const wire = new Uint8Array(1 + numSigs * 64 + messageBytes.length);
  wire[0] = numSigs;
  for (let i = 0; i < numSigs; i++) {
    const sig = sigEntries[i]![1];
    if (sig) wire.set(sig, 1 + i * 64);
  }
  wire.set(messageBytes, 1 + numSigs * 64);
  return wire;
}

// ---------------------------------------------------------------------------
// Remote Solana signer (delegates to Privy via ACP server)
// ---------------------------------------------------------------------------

function createPrivySolanaSigner(params: {
  address: Address;
  walletId: string;
  signerPrivateKey?: string;
  signFn?: SignFn;
  serverUrl: string;
  privyAppId: string;
}): SolanaSigner {
  const { address, walletId, signerPrivateKey, signFn, serverUrl, privyAppId } =
    params;

  return {
    address,

    async signTransactions(transactions: readonly any[]): Promise<any> {
      return Promise.all(
        transactions.map(async (tx: any) => {
          const wireBytes = buildUnsignedWireBytes(
            new Uint8Array(tx.messageBytes),
            tx.signatures as Record<string, Uint8Array | null>,
          );
          const unsignedBase64 = Buffer.from(wireBytes).toString("base64");

          const rpcBody = {
            method: "signTransaction" as const,
            chain_type: "solana" as const,
            params: {
              transaction: unsignedBase64,
              encoding: "base64" as const,
            },
          };

          const result = await signedServerCall<{
            signedTransaction: string;
          }>(
            "/wallets/solana/sign-transaction",
            walletId,
            rpcBody,
            {
              walletAddress: address,
              walletId,
              transaction: unsignedBase64,
            },
            signerPrivateKey,
            serverUrl,
            privyAppId,
            signFn,
          );

          const signedWire = new Uint8Array(
            Buffer.from(result.signedTransaction, "base64"),
          );
          const sigAddresses = Object.keys(tx.signatures);
          const ourIndex = sigAddresses.indexOf(address as string);
          if (ourIndex < 0) {
            throw new Error(
              "Signer address not found in transaction signatures",
            );
          }
          const sigBytes = signedWire.subarray(
            1 + ourIndex * 64,
            1 + (ourIndex + 1) * 64,
          );

          return Object.freeze({ [address]: sigBytes });
        }),
      );
    },

    async signMessages(messages: readonly any[]): Promise<any> {
      return Promise.all(
        messages.map(async (msg: any) => {
          const contentBase64 = Buffer.from(msg.content).toString("base64");

          const rpcBody = {
            method: "signMessage" as const,
            chain_type: "solana" as const,
            params: { message: contentBase64, encoding: "base64" as const },
          };

          const result = await signedServerCall<{ signature: string }>(
            "/wallets/solana/sign-message",
            walletId,
            rpcBody,
            {
              walletAddress: address,
              walletId,
              message: contentBase64,
            },
            signerPrivateKey,
            serverUrl,
            privyAppId,
            signFn,
          );

          const sigBytes = new Uint8Array(
            Buffer.from(result.signature, "base64"),
          );
          return Object.freeze({ [address]: sigBytes });
        }),
      );
    },
  } as SolanaSigner;
}

// ---------------------------------------------------------------------------
// PrivySolanaProviderAdapter
// ---------------------------------------------------------------------------

export class PrivySolanaProviderAdapter extends SolanaProviderAdapter {
  private readonly _address: string;
  private readonly _rpc: Rpc<SolanaRpcApi>;
  private readonly _cluster: SolanaCluster;
  private readonly _signer: SolanaSigner;

  // Privy signing params (stored for direct signTransaction calls)
  private readonly _walletId: string;
  private readonly _signerPrivateKey: string | undefined;
  private readonly _signFn: SignFn | undefined;
  private readonly _serverUrl: string;
  private readonly _privyAppId: string;

  // Gas sponsorship (policy injected server-side)
  private readonly _rpcProxyUrl: string | null;
  private _getAuthToken: (() => Promise<string>) | null = null;
  private readonly _sponsored: boolean;
  private readonly _onSponsoredRetry: PrivySolanaConfig["onSponsoredRetry"];
  // Slot of the most recently confirmed transaction sent through this
  // adapter — the slot the sponsor node must reach to see account state
  // created by the previous step (e.g. createJob before setBudget).
  private _lastConfirmedSlot: bigint | null = null;

  private constructor(params: {
    address: string;
    rpc: Rpc<SolanaRpcApi>;
    cluster: SolanaCluster;
    signer: SolanaSigner;
    walletId: string;
    signerPrivateKey?: string;
    signFn?: SignFn;
    serverUrl: string;
    privyAppId: string;
    rpcProxyUrl: string | null;
    sponsored: boolean;
    onSponsoredRetry?: PrivySolanaConfig["onSponsoredRetry"];
  }) {
    super("privy-solana");
    this._address = params.address;
    this._rpc = params.rpc;
    this._cluster = params.cluster;
    this._signer = params.signer;
    this._walletId = params.walletId;
    this._signerPrivateKey = params.signerPrivateKey;
    this._signFn = params.signFn;
    this._serverUrl = params.serverUrl;
    this._privyAppId = params.privyAppId;
    this._rpcProxyUrl = params.rpcProxyUrl;
    this._sponsored = params.sponsored;
    this._onSponsoredRetry = params.onSponsoredRetry;
  }

  static async create(
    params: PrivySolanaConfig,
  ): Promise<PrivySolanaProviderAdapter> {
    if (!params.signerPrivateKey && !params.signFn) {
      throw new Error(
        "PrivySolanaProviderAdapter: either signerPrivateKey or signFn must be provided",
      );
    }

    const serverUrl = (params.serverUrl ?? ACP_SERVER_URL).replace(/\/$/, "");
    const privyAppId = params.privyAppId ?? PRIVY_APP_ID;
    const chainId = params.chainId ?? SOLANA_DEVNET_CHAIN_ID;
    const cluster = SOLANA_CHAIN_ID_CLUSTERS[chainId] as
      | SolanaCluster
      | undefined;
    if (!cluster) {
      throw new Error(`Unsupported Solana chainId: ${chainId}`);
    }
    const address = params.walletAddress as Address;

    const signer = createPrivySolanaSigner({
      address,
      walletId: params.walletId,
      ...(params.signerPrivateKey
        ? { signerPrivateKey: params.signerPrivateKey }
        : {}),
      ...(params.signFn ? { signFn: params.signFn } : {}),
      serverUrl,
      privyAppId,
    });

    let rpc: Rpc<SolanaRpcApi>;
    let rpcProxyUrl: string | null = null;
    let getToken: (() => Promise<string>) | null = null;

    if (params.rpcUrl) {
      rpc = createSolanaRpc(params.rpcUrl) as Rpc<SolanaRpcApi>;
    } else {
      rpcProxyUrl = `${serverUrl}/wallets/solana-rpc/${chainId}`;

      const authClient = new ProviderAuthClient({
        serverUrl,
        walletAddress: params.walletAddress,
        signMessage: async (msg: string) => {
          const signable = createSignableMessage(msg);
          const [sigs] = await signer.signMessages([signable]);
          const sigBytes = sigs![address];
          if (!sigBytes) throw new Error("Solana message signing failed");
          return getBase58Decoder().decode(sigBytes);
        },
        chainId,
      });

      getToken = () => authClient.getAuthToken();

      const proxyUrl = rpcProxyUrl;
      const transport = async (config: { payload: unknown }): Promise<any> => {
        const token = await getToken!();
        const res = await fetch(proxyUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(config.payload),
        });
        return await res.json();
      };

      rpc = createSolanaRpcFromTransport(transport as any) as Rpc<SolanaRpcApi>;
    }

    const adapter = new PrivySolanaProviderAdapter({
      address: params.walletAddress,
      rpc,
      cluster,
      signer,
      walletId: params.walletId,
      ...(params.signerPrivateKey
        ? { signerPrivateKey: params.signerPrivateKey }
        : {}),
      ...(params.signFn ? { signFn: params.signFn } : {}),
      serverUrl,
      privyAppId,
      rpcProxyUrl,
      sponsored: params.sponsored ?? true,
      ...(params.onSponsoredRetry
        ? { onSponsoredRetry: params.onSponsoredRetry }
        : {}),
    });
    adapter._getAuthToken = getToken;
    return adapter;
  }

  async getAddress(): Promise<string> {
    return this._address;
  }

  async getCluster(): Promise<SolanaCluster> {
    return this._cluster;
  }

  getRpc(): Rpc<SolanaRpcApi> {
    return this._rpc;
  }

  getSigner(): SolanaSigner {
    return this._signer;
  }

  // -------------------------------------------------------------------------
  // Gas sponsorship: alchemy_requestFeePayer
  // -------------------------------------------------------------------------

  private async requestFeePayer(serializedTransaction: string): Promise<{
    serializedTransaction: string;
    simulationSlot: bigint | null;
  }> {
    if (!this._rpcProxyUrl || !this._getAuthToken) {
      throw new Error("Gas sponsorship requires a proxied RPC connection");
    }

    const token = await this._getAuthToken();
    const res = await fetch(this._rpcProxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_requestFeePayer",
        params: [
          {
            serializedTransaction,
            prefundRent: true,
          },
        ],
      }),
    });

    const json = (await res.json()) as any;
    if (json.error) {
      throw new Error(
        `alchemy_requestFeePayer failed: ${json.error.message ?? JSON.stringify(json.error)}`,
      );
    }
    // simulationSlot is returned when prefundRent is true — the slot Alchemy's
    // rent-prefunding simulation ran at. Alchemy's docs: "pass it as
    // minContextSlot when submitting the transaction."
    const rawSlot = json.result.simulationSlot;
    return {
      serializedTransaction: json.result.serializedTransaction,
      simulationSlot: rawSlot != null ? BigInt(rawSlot) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Direct Privy transaction signing (for sponsored flow)
  // -------------------------------------------------------------------------

  private async signTransactionViaPrivy(
    transactionBase64: string,
  ): Promise<string> {
    const rpcBody = {
      method: "signTransaction" as const,
      chain_type: "solana" as const,
      params: { transaction: transactionBase64, encoding: "base64" as const },
    };

    const result = await signedServerCall<{ signedTransaction: string }>(
      "/wallets/solana/sign-transaction",
      this._walletId,
      rpcBody,
      {
        walletAddress: this._address,
        walletId: this._walletId,
        transaction: transactionBase64,
      },
      this._signerPrivateKey,
      this._serverUrl,
      this._privyAppId,
      this._signFn,
    );

    return result.signedTransaction;
  }

  // -------------------------------------------------------------------------
  // sendInstructions
  // -------------------------------------------------------------------------

  async sendInstructions(
    instructions: SolanaInstructionLike[],
    options?: SendInstructionsOptions,
  ): Promise<string> {
    // Sponsorship applies only to ACP actions (batches touching an ACP
    // program). Everything else — generic transfers, unrelated instructions —
    // is self-paid.
    const isAcpAction = instructions.some((ix) =>
      SPONSORABLE_PROGRAM_IDS.has(ix.programAddress as string),
    );
    const useSponsorship =
      this._sponsored &&
      !!this._rpcProxyUrl &&
      !!this._getAuthToken &&
      isAcpAction;

    if (useSponsorship) {
      return this.sendSponsoredTransaction(instructions, options);
    }

    const { value: latestBlockhash } = await this._rpc
      .getLatestBlockhash()
      .send();

    // const useSponsorship = this._rpcProxyUrl && this._getAuthToken;

    // if (useSponsorship) {
    //   return this.sendSponsoredTransaction(instructions, latestBlockhash);
    // }
    return this.sendSelfPayTransaction(instructions, latestBlockhash);
  }

  /**
   * Standard flow: user pays own fees.
   */
  private async sendSelfPayTransaction(
    instructions: SolanaInstructionLike[],
    latestBlockhash: any,
  ): Promise<string> {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(this._signer.address, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions(instructions, msg),
      (msg) => addSignersToTransactionMessage([this._signer], msg),
    );

    const signedTx = await signTransactionMessageWithSigners(message);
    const encodedTx = getBase64EncodedWireTransaction(signedTx);
    return this.broadcastAndConfirm(encodedTx);
  }

  /**
   * Sponsored flow (per attempt, all inside withFeePayerRetry):
   * 1. Fetch a fresh blockhash and build tx with Alchemy placeholder fee payer
   * 2. alchemy_requestFeePayer → Alchemy replaces payer & adds its sig
   * 3. Privy signs the sponsored tx (adds user sig)
   * 4. Broadcast
   *
   * The whole sequence is retried — not just requestFeePayer — because the
   * sponsor's simulation node AND the broadcast node can each lag our read RPC
   * by a few slots, so state we just confirmed (a new job PDA, an updated
   * budget, the sponsor's own fee-payer credit) may not be visible yet. A
   * fresh blockhash is fetched on every attempt so retries never reuse a
   * stale/expired one.
   *
   * Sponsor-side simulation lag (requestFeePayer) cannot be avoided —
   * alchemy_requestFeePayer accepts no minContextSlot and its simulation is
   * the sponsorship policy gate. Broadcast-side lag IS avoided: we pass
   * max(Alchemy's simulationSlot, our last confirmed slot) as minContextSlot
   * to sendTransaction, so preflight never runs against state older than what
   * the sponsor simulated; a lagging node returns a retryable -32016 instead.
   */
  private async sendSponsoredTransaction(
    instructions: SolanaInstructionLike[],
    options?: SendInstructionsOptions,
  ): Promise<string> {
    // Slot our read RPC was at when the current attempt's blockhash was
    // fetched — the state the sponsor's simulation node has not caught up
    // to yet when a retryable lag error occurs.
    let lastSeenSlot: bigint | null = null;
    // The minContextSlot passed to the current attempt's broadcast — i.e. the
    // exact slot a -32016 "minimum context slot not reached" error means the
    // broadcast node failed to reach. Reset each attempt; only set once the
    // attempt actually reaches the broadcast step.
    let lastMinContextSlot: bigint | null = null;

    return withFeePayerRetry(
      async () => {
        lastMinContextSlot = null;
        // 1. Fresh blockhash + build tx with user as placeholder fee payer
        //    (Alchemy replaces it + prefunds CPI rent).
        const { context, value: latestBlockhash } = await this._rpc
          .getLatestBlockhash()
          .send();
        lastSeenSlot = context.slot;

        const message = pipe(
          createTransactionMessage({ version: 0 }),
          (msg) => setTransactionMessageFeePayer(this._signer.address, msg),
          (msg) =>
            setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
          (msg) => appendTransactionMessageInstructions(instructions, msg),
        );

        const compiled = compileTransaction(message);
        const wireBytes = getTransactionEncoder().encode(compiled);
        const unsignedBase64 = Buffer.from(wireBytes).toString("base64");

        // 2. Request gas sponsorship.
        const { serializedTransaction: sponsoredBase64, simulationSlot } =
          await this.requestFeePayer(unsignedBase64);

        // 3. Sign with Privy (user's signature).
        const signedBase64 =
          await this.signTransactionViaPrivy(sponsoredBase64);

        // 4. Broadcast + confirm. minContextSlot forces the broadcast node's
        //    preflight to run against state at least as fresh as both
        //    Alchemy's sponsorship simulation (simulationSlot) and our
        //    previous confirmed step (_lastConfirmedSlot) — a lagging node
        //    returns an explicit, retryable -32016 instead of a misleading
        //    simulation failure.
        const minContextSlot = maxSlot(simulationSlot, this._lastConfirmedSlot);
        lastMinContextSlot = minContextSlot;
        return this.broadcastAndConfirm(signedBase64, minContextSlot);
      },
      {
        ...(options?.retryGuard ? { retryGuard: options.retryGuard } : {}),
        onRetry: (attempt, maxAttempts, message, error) => {
          const { requiredSlot, nodeSlot } = resolveSponsoredRetrySlots(error, {
            lastMinContextSlot,
            lastConfirmedSlot: this._lastConfirmedSlot,
            lastSeenSlot,
          });
          if (this._onSponsoredRetry) {
            this._onSponsoredRetry({
              attempt,
              maxAttempts,
              slot: lastSeenSlot,
              requiredSlot,
              nodeSlot,
              rawError: message,
            });
            return;
          }
          console.warn(
            formatSponsoredRetryWarning(
              requiredSlot,
              nodeSlot,
              attempt,
              maxAttempts,
            ),
          );
        },
      },
    );
  }

  // -------------------------------------------------------------------------
  // Broadcast + confirm
  // -------------------------------------------------------------------------

  private async broadcastAndConfirm(
    encodedTx: string,
    minContextSlot?: bigint | null,
  ): Promise<string> {
    let signature: Signature;
    try {
      signature = await this._rpc
        .sendTransaction(encodedTx as any, {
          encoding: "base64",
          ...(minContextSlot != null
            ? { minContextSlot: minContextSlot as Slot }
            : {}),
        })
        .send();
    } catch (err: unknown) {
      const errObj = err as Record<string, unknown>;
      const context = errObj?.context as Record<string, unknown> | undefined;
      const cause = errObj?.cause as Record<string, unknown> | undefined;
      const logs =
        (context?.logs as string[]) ??
        (cause?.logs as string[]) ??
        (errObj?.logs as string[]);
      if (logs?.length) {
        throw new Error(`Transaction simulation failed:\n${logs.join("\n")}`);
      }
      throw err;
    }

    for (let i = 0; i < 30; i++) {
      const { value } = await this._rpc
        .getSignatureStatuses([signature])
        .send();
      const status = value[0];
      if (status) {
        if (status.err) {
          throw new Error(
            `Transaction failed: ${stringifyBigIntSafe(status.err)}`,
          );
        }
        if (
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"
        ) {
          this._lastConfirmedSlot = status.slot;
          return signature;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Transaction confirmation timeout: ${signature}`);
  }
}
