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
  type SolanaRpcApi,
  type Commitment,
} from "@solana/kit";
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
  ACP_CONTRACT_ADDRESSES,
  FUND_TRANSFER_HOOK_ADDRESSES,
  ACP_COMMITMENT,
  MULTI_HOOK_ROUTER_ADDRESSES,
  SUBSCRIPTION_HOOK_ADDRESSES,
  SUBSCRIPTION_STATE_ADDRESSES,
  ALT_PROGRAM_ID,
  defaultSplFeeTokens,
} from "../../core/constants.js";
import { ProviderAuthClient } from "../providerAuthClient.js";
import {
  ApprovalRequiredError,
  awaitApproval,
} from "../../core/approvalGate.js";
import { withFeePayerRetry } from "./feePayerRetry.js";
import { stringifyBigIntSafe } from "../../core/solana/serialization.js";
import { confirmTransaction } from "./txConfirmation.js";
import { KoraClient, type KoraPayer } from "./koraClient.js";
import { getSplTokenBalance } from "../../core/solana/wallet.js";

// Sponsorship covers ACP-protocol actions: batches touching the cluster's ACP
// program, fund-transfer hook, multi-hook router, subscription hook/state, or
// the Address Lookup Table program (ALT setup for multi-hook jobs). Everything
// these actions create has rent welded to the acting wallet, so it must stay on
// the Alchemy sponsored path (prefundRent) rather than the Kora SPL path, which
// creates only ATAs. Derived per chainId so devnet and mainnet each recognize
// their own deployments. The chain-keyed maps hold "" for chains where a
// program isn't deployed (e.g. router/subscription on Solana mainnet), so the
// filter drops every falsy value, not just undefined. ALT is a fixed native
// program, identical on every cluster.
const sponsorableCache = new Map<number, ReadonlySet<string>>();
function sponsorableProgramIds(chainId: number): ReadonlySet<string> {
  let set = sponsorableCache.get(chainId);
  if (!set) {
    set = new Set(
      [
        ACP_CONTRACT_ADDRESSES[chainId],
        FUND_TRANSFER_HOOK_ADDRESSES[chainId],
        MULTI_HOOK_ROUTER_ADDRESSES[chainId],
        SUBSCRIPTION_HOOK_ADDRESSES[chainId],
        SUBSCRIPTION_STATE_ADDRESSES[chainId],
        ALT_PROGRAM_ID,
      ].filter((a): a is string => !!a),
    );
    sponsorableCache.set(chainId, set);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type SignFn = (payload: Uint8Array) => Promise<string>;

export interface PrivySolanaConfig {
  walletAddress: string;
  walletId: string;
  signerPrivateKey?: string;
  signFn?: SignFn;
  /**
   * @deprecated Use `chainIds`. Single Solana chain ID (500 = devnet,
   * 501 = mainnet). Defaults to devnet when neither field is set.
   */
  chainId?: number;
  /**
   * Solana chain IDs served simultaneously (500 = devnet, 501 = mainnet).
   * Takes precedence over `chainId`. Defaults to `[chainId]`, else devnet.
   */
  chainIds?: number[];
  /**
   * @deprecated Use `rpcUrls`. Explicit RPC URL; only valid when exactly one
   * chain is configured. When set, bypasses the ACP server proxy.
   */
  rpcUrl?: string;
  /**
   * Explicit RPC URL per chainId. Chains listed here bypass the ACP server
   * proxy (and thus gas sponsorship); chains not listed use the proxy.
   */
  rpcUrls?: Record<number, string>;
  serverUrl?: string;
  privyAppId?: string;
  sponsored?: boolean;
  /**
   * Commitment every send's preflight simulation runs at, overridable per call
   * via SendInstructionsOptions. Defaults to ACP_COMMITMENT ("confirmed") to
   * match the level ACP reads run at, so preflight simulates against the same
   * state the transaction was built on. The RPC's own default ("finalized")
   * trails by ~32 slots and fails steps that depend on the previous one.
   */
  preflightCommitment?: Commitment;
  /**
   * Called when a sponsored send is retried due to sponsor-node lag.
   * When provided, replaces the default one-line console notice. `slot` is
   * the read RPC's slot at blockhash fetch, `requiredSlot` is the slot in
   * which the required account state was created (the slot the sponsor node
   * must reach), `nodeSlot` is the lagging node's own slot on the rare error
   * that exposes it (a -32016 minimum-context-slot error; sponsor simulation
   * failures leave it null), and `rawError` carries the underlying
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
  /**
   * Kora paymaster JSON-RPC URL per chainId (reached through the ACP server
   * proxy). When set for a chain, non-ACP transactions on that chain are paid
   * in SPL via Kora instead of self-paying SOL. Defaults to
   * `${serverUrl}/wallets/solana-kora-rpc/${chainId}` for every proxied chain;
   * pass `{}` or omit a chain to disable Kora there (falls back to self-pay).
   */
  koraRpcUrls?: Record<number, string>;
  /**
   * SPL fee-token mints to try, in priority order, for Kora-paid transactions
   * on a chain. Defaults to `defaultSplFeeTokens(chainId)` (VIRTUAL -> USDC ->
   * USDT). The first tier the wallet can cover wins.
   */
  splFeeTokens?: Record<number, string[]>;
}

// Extracts the responding node's slot from an error chain, when the error
// carries one (as `contextSlot` on the SolanaError context). Only a -32016
// "minimum context slot not reached" error does; we no longer send a
// minContextSlot ourselves, so this is populated only when the RPC provider
// applies its own min-context constraint. Alchemy's sponsorship simulation
// errors report no slot.
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
 *   - `nodeSlot`: the responding node's slot, present only when the error
 *     carries one (see extractNodeContextSlot) — usually null.
 *   - `requiredSlot`: the slot the failing step needed to reach. Both the
 *     sponsor's simulation and the broadcast node fail with a plain error
 *     carrying no slot, so this is the last confirmed slot — the slot in
 *     which the state the transaction depends on was created — falling back
 *     to our read RPC's blockhash slot, by which that state is likewise
 *     visible, so it remains a valid sync target.
 */
export function resolveSponsoredRetrySlots(
  error: unknown,
  slots: {
    lastConfirmedSlot: bigint | null;
    lastSeenSlot: bigint | null;
  },
): { requiredSlot: bigint | null; nodeSlot: bigint | null } {
  return {
    nodeSlot: extractNodeContextSlot(error),
    requiredSlot: slots.lastConfirmedSlot ?? slots.lastSeenSlot,
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
    ? `[gas_sponsorship] sponsor node ${gap} slot${gap === 1n ? "" : "s"} behind required slot ${requiredSlot} (attempt ${attempt}/${maxAttempts})`
    : requiredSlot != null
      ? `[gas_sponsorship] waiting for sponsor node to reach slot ${requiredSlot} (attempt ${attempt}/${maxAttempts})`
      : `[gas_sponsorship] sponsor node syncing, waiting (attempt ${attempt}/${maxAttempts})`;
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
        `[gas_sponsorship] Manual approval required.\n` +
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

/**
 * Thrown when the Kora SPL-paid path has no fee token the wallet can cover.
 * Deliberately NOT caught as a fallback — the wallet has no SOL to self-pay
 * either, so silently spending SOL would be wrong. Mirrors the EVM error.
 */
export class InsufficientFeeTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientFeeTokenError";
  }
}

export class PrivySolanaProviderAdapter extends SolanaProviderAdapter {
  private readonly _address: string;
  private readonly _rpcs: Map<number, Rpc<SolanaRpcApi>>;
  private readonly _signer: SolanaSigner;

  // Privy signing params (stored for direct signTransaction calls)
  private readonly _walletId: string;
  private readonly _signerPrivateKey: string | undefined;
  private readonly _signFn: SignFn | undefined;
  private readonly _serverUrl: string;
  private readonly _privyAppId: string;

  // Gas sponsorship (policy injected server-side). Chains served through the
  // ACP server proxy have an entry in _rpcProxyUrls; explicit-rpcUrl chains
  // do not and are never sponsored.
  private readonly _rpcProxyUrls: Map<number, string>;
  private _getAuthToken: (() => Promise<string>) | null = null;
  private readonly _sponsored: boolean;
  private readonly _onSponsoredRetry: PrivySolanaConfig["onSponsoredRetry"];
  private readonly _preflightCommitment: Commitment;
  // Slot of the most recently confirmed transaction per chain — the slot the
  // sponsor node must reach to see account state created by the previous
  // step (e.g. createJob before setBudget). Per-chain because devnet and
  // mainnet slot numbers are unrelated streams.
  private readonly _lastConfirmedSlot = new Map<number, bigint>();

  // Kora SPL-paid path. A chain has a KoraClient only when a Kora URL was
  // configured for it; non-ACP transactions on such chains are paid in SPL
  // rather than self-paying SOL. _splFeeTokens is the per-chain tier list; the
  // resolved Kora payer is cached per chain (stable per node).
  private readonly _koraClients: Map<number, KoraClient>;
  private readonly _splFeeTokens: Map<number, string[]>;
  private readonly _koraPayer = new Map<number, KoraPayer>();

  private constructor(params: {
    address: string;
    rpcs: Map<number, Rpc<SolanaRpcApi>>;
    signer: SolanaSigner;
    walletId: string;
    signerPrivateKey?: string;
    signFn?: SignFn;
    serverUrl: string;
    privyAppId: string;
    rpcProxyUrls: Map<number, string>;
    sponsored: boolean;
    preflightCommitment: Commitment;
    onSponsoredRetry?: PrivySolanaConfig["onSponsoredRetry"];
    koraClients: Map<number, KoraClient>;
    splFeeTokens: Map<number, string[]>;
  }) {
    super("privy-solana");
    this._address = params.address;
    this._rpcs = params.rpcs;
    this._signer = params.signer;
    this._walletId = params.walletId;
    this._signerPrivateKey = params.signerPrivateKey;
    this._signFn = params.signFn;
    this._serverUrl = params.serverUrl;
    this._privyAppId = params.privyAppId;
    this._rpcProxyUrls = params.rpcProxyUrls;
    this._sponsored = params.sponsored;
    this._preflightCommitment = params.preflightCommitment;
    this._onSponsoredRetry = params.onSponsoredRetry;
    this._koraClients = params.koraClients;
    this._splFeeTokens = params.splFeeTokens;
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
    const chainIds =
      params.chainIds ??
      (params.chainId != null ? [params.chainId] : [SOLANA_DEVNET_CHAIN_ID]);
    if (chainIds.length === 0) {
      throw new Error("PrivySolanaProviderAdapter: chainIds must not be empty");
    }
    for (const chainId of chainIds) {
      if (!SOLANA_CHAIN_ID_CLUSTERS[chainId]) {
        throw new Error(`Unsupported Solana chainId: ${chainId}`);
      }
    }
    if (params.rpcUrl && chainIds.length > 1) {
      throw new Error(
        "PrivySolanaProviderAdapter: rpcUrl is single-chain; use rpcUrls with multiple chainIds",
      );
    }
    const rpcUrls: Record<number, string> = {
      ...(params.rpcUrl ? { [chainIds[0]!]: params.rpcUrl } : {}),
      ...params.rpcUrls,
    };
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

    const rpcs = new Map<number, Rpc<SolanaRpcApi>>();
    const rpcProxyUrls = new Map<number, string>();
    const koraClients = new Map<number, KoraClient>();
    const splFeeTokens = new Map<number, string[]>();
    let getToken: (() => Promise<string>) | null = null;

    // One auth client serves every proxied chain (auth is wallet-scoped, keyed
    // to the first chain — same pattern as the EVM adapter).
    const ensureToken = (): (() => Promise<string>) => {
      if (!getToken) {
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
          chainId: chainIds[0]!,
        });
        getToken = () => authClient.getAuthToken();
      }
      return getToken;
    };

    for (const chainId of chainIds) {
      const explicitUrl = rpcUrls[chainId];
      if (explicitUrl) {
        rpcs.set(chainId, createSolanaRpc(explicitUrl) as Rpc<SolanaRpcApi>);
        continue;
      }
      const proxyUrl = `${serverUrl}/wallets/solana-rpc/${chainId}`;
      rpcProxyUrls.set(chainId, proxyUrl);
      const token = ensureToken();

      // Kora SPL-paid path for this proxied chain. `koraRpcUrls` undefined =>
      // default the URL on for every proxied chain; a provided map opts in
      // per chain (absent chain => disabled). Only register when at least one
      // fee-token mint is configured, so `_koraClients.has(chainId)` means
      // "Kora is usable here"; otherwise the send path falls back to self-pay.
      const koraUrl =
        params.koraRpcUrls === undefined
          ? `${serverUrl}/wallets/solana-kora-rpc/${chainId}`
          : params.koraRpcUrls[chainId];
      if (koraUrl) {
        const tiers =
          params.splFeeTokens?.[chainId] ?? defaultSplFeeTokens(chainId);
        if (tiers.length > 0) {
          koraClients.set(chainId, new KoraClient({ url: koraUrl, getToken: token }));
          splFeeTokens.set(chainId, tiers);
        }
      }

      const transport = async (config: { payload: unknown }): Promise<any> => {
        const res = await fetch(proxyUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await token()}`,
          },
          body: JSON.stringify(config.payload),
        });
        return await res.json();
      };
      rpcs.set(
        chainId,
        createSolanaRpcFromTransport(transport as any) as Rpc<SolanaRpcApi>,
      );
    }

    const adapter = new PrivySolanaProviderAdapter({
      address: params.walletAddress,
      rpcs,
      signer,
      walletId: params.walletId,
      ...(params.signerPrivateKey
        ? { signerPrivateKey: params.signerPrivateKey }
        : {}),
      ...(params.signFn ? { signFn: params.signFn } : {}),
      serverUrl,
      privyAppId,
      rpcProxyUrls,
      sponsored: params.sponsored ?? true,
      preflightCommitment: params.preflightCommitment ?? ACP_COMMITMENT,
      ...(params.onSponsoredRetry
        ? { onSponsoredRetry: params.onSponsoredRetry }
        : {}),
      koraClients,
      splFeeTokens,
    });
    adapter._getAuthToken = getToken;
    return adapter;
  }

  async getAddress(): Promise<string> {
    return this._address;
  }

  override async getSupportedChainIds(): Promise<number[]> {
    return [...this._rpcs.keys()];
  }

  getRpc(chainId: number): Rpc<SolanaRpcApi> {
    const rpc = this._rpcs.get(chainId);
    if (!rpc) {
      throw new Error(
        `PrivySolanaProviderAdapter: no RPC configured for chainId ${chainId}`,
      );
    }
    return rpc;
  }

  getSigner(): SolanaSigner {
    return this._signer;
  }

  // -------------------------------------------------------------------------
  // Gas sponsorship: alchemy_requestFeePayer
  // -------------------------------------------------------------------------

  private async requestFeePayer(
    chainId: number,
    serializedTransaction: string,
  ): Promise<string> {
    const rpcProxyUrl = this._rpcProxyUrls.get(chainId);
    if (!rpcProxyUrl || !this._getAuthToken) {
      throw new Error("Gas sponsorship requires a proxied RPC connection");
    }

    const token = await this._getAuthToken();
    const res = await fetch(rpcProxyUrl, {
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
    return json.result.serializedTransaction as string;
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
    chainId: number,
    instructions: SolanaInstructionLike[],
    options?: SendInstructionsOptions,
  ): Promise<string> {
    // Sponsorship applies only to ACP actions (batches touching this chain's
    // ACP program or hook). Everything else — generic transfers, unrelated
    // instructions — is self-paid.
    const sponsorable = sponsorableProgramIds(chainId);
    const isAcpAction = instructions.some((ix) =>
      sponsorable.has(ix.programAddress as string),
    );
    const useSponsorship =
      this._sponsored &&
      this._rpcProxyUrls.has(chainId) &&
      !!this._getAuthToken &&
      isAcpAction;

    if (useSponsorship) {
      return this.sendSponsoredTransaction(chainId, instructions, options);
    }

    // Non-ACP action. If Kora is configured for this chain, pay fees in SPL.
    // The probe is getPayerSigner (cached): if it fails, the Kora endpoint is
    // absent or unhealthy (e.g. not yet deployed) and we fall back to self-pay
    // — this happens before anything is built/signed/broadcast, so there is no
    // double-send risk. A no-balance failure inside sendSplPaidTransaction is
    // NOT a fallback: it throws, because the wallet has no SOL to spend either.
    if (this._koraClients.has(chainId)) {
      const koraPayer = await this.resolveKoraPayer(chainId).catch((err) => {
        console.warn(
          `[kora] getPayerSigner failed on chain ${chainId}; falling back to self-pay: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      });
      if (koraPayer) {
        return this.sendSplPaidTransaction(
          chainId,
          instructions,
          koraPayer,
          options,
        );
      }
    }

    const { value: latestBlockhash } = await this.getRpc(chainId)
      .getLatestBlockhash()
      .send();

    return this.sendSelfPayTransaction(
      chainId,
      instructions,
      latestBlockhash,
      options,
    );
  }

  /** Cached Kora fee payer for a chain (stable per node). */
  private async resolveKoraPayer(chainId: number): Promise<KoraPayer> {
    const cached = this._koraPayer.get(chainId);
    if (cached) return cached;
    const client = this._koraClients.get(chainId);
    if (!client) {
      throw new Error(`No Kora client configured for chainId ${chainId}`);
    }
    const payer = await client.getPayerSigner();
    this._koraPayer.set(chainId, payer);
    return payer;
  }

  /**
   * Standard flow: user pays own fees.
   */
  private async sendSelfPayTransaction(
    chainId: number,
    instructions: SolanaInstructionLike[],
    latestBlockhash: any,
    options?: SendInstructionsOptions,
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
    return this.broadcastAndConfirm(
      chainId,
      encodedTx,
      latestBlockhash.lastValidBlockHeight,
      options,
    );
  }

  // -------------------------------------------------------------------------
  // Kora SPL-paid path
  // -------------------------------------------------------------------------

  /**
   * Rent payer for account creation (ATAs). When Kora is active for the chain,
   * its fee payer fronts the rent (reimbursed in SPL via the payment
   * instruction); otherwise the wallet self-funds. Callers pass this as the
   * `payer` argument to the wallet.ts instruction builders.
   */
  override async getRentPayer(chainId: number): Promise<string> {
    if (this._koraClients.has(chainId)) {
      const payer = await this.resolveKoraPayer(chainId).catch(() => null);
      if (payer) return payer.signerAddress;
    }
    return this._signer.address;
  }

  /**
   * Pick the first fee token (in configured priority order) whose balance
   * covers Kora's quote for `unsignedBase64`. Balances are read in parallel;
   * only tokens with a positive balance are quoted. Returns null when no tier
   * is affordable.
   */
  private async selectFeeToken(
    chainId: number,
    unsignedBase64: string,
  ): Promise<string | null> {
    const client = this._koraClients.get(chainId)!;
    const tiers = this._splFeeTokens.get(chainId) ?? [];
    const rpc = this.getRpc(chainId);
    const owner = this._address as Address;

    const balances = await Promise.all(
      tiers.map((mint) =>
        getSplTokenBalance(rpc, owner, mint as Address)
          .then((b) => b.amount)
          .catch(() => 0n),
      ),
    );

    for (let i = 0; i < tiers.length; i++) {
      if (balances[i]! <= 0n) continue;
      const quote = await client.estimateTransactionFee(unsignedBase64, tiers[i]!);
      if (balances[i]! >= quote.feeInToken) return tiers[i]!;
    }
    return null;
  }

  /**
   * SPL-paid flow (per attempt, inside withFeePayerRetry):
   * 1. Fresh blockhash; build tx with Kora's payer as fee payer + the caller's
   *    instructions (Kora's payer is known up front — no placeholder mutation).
   * 2. Pick a fee token the wallet can cover (selectFeeToken).
   * 3. getPaymentInstruction → append the SPL payment (wallet -> Kora).
   * 4. Privy signs (user sig); Kora co-signs as fee payer.
   * 5. Broadcast + confirm.
   *
   * A fresh blockhash per attempt means retries never reuse a stale one. Unlike
   * the Alchemy path there is no simulationSlot, so minContextSlot falls back to
   * our last confirmed slot — sufficient because a self-hosted Kora reads from
   * the same RPC we do.
   */
  private async sendSplPaidTransaction(
    chainId: number,
    instructions: SolanaInstructionLike[],
    koraPayer: KoraPayer,
    options?: SendInstructionsOptions,
  ): Promise<string> {
    const client = this._koraClients.get(chainId)!;
    let lastSeenSlot: bigint | null = null;

    return withFeePayerRetry(
      async () => {
        const { context, value: latestBlockhash } = await this.getRpc(chainId)
          .getLatestBlockhash()
          .send();
        lastSeenSlot = context.slot;

        // Build with Kora's payer as fee payer, then compile to unsigned bytes
        // for the fee quote + payment instruction.
        const baseMessage = pipe(
          createTransactionMessage({ version: 0 }),
          (msg) => setTransactionMessageFeePayer(koraPayer.signerAddress, msg),
          (msg) =>
            setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
          (msg) => appendTransactionMessageInstructions(instructions, msg),
        );
        const unsignedBase64 = Buffer.from(
          getTransactionEncoder().encode(compileTransaction(baseMessage)),
        ).toString("base64");

        const feeToken = await this.selectFeeToken(chainId, unsignedBase64);
        if (!feeToken) {
          throw new InsufficientFeeTokenError(
            "Not enough balance to cover the network fee. Add USDC, USDT, or VIRTUAL to your wallet and try again.",
          );
        }

        const paymentIx = await client.getPaymentInstruction({
          transactionBase64: unsignedBase64,
          feeToken,
          sourceWallet: this._address,
        });

        // Append the payment instruction, recompile, and collect signatures:
        // the user's (Privy) then Kora's (fee payer).
        const finalMessage = appendTransactionMessageInstructions(
          [paymentIx],
          baseMessage,
        );
        const finalBase64 = Buffer.from(
          getTransactionEncoder().encode(compileTransaction(finalMessage)),
        ).toString("base64");

        const userSigned = await this.signTransactionViaPrivy(finalBase64);
        const fullySigned = await client.signTransaction(userSigned);

        return this.broadcastAndConfirm(
          chainId,
          fullySigned,
          latestBlockhash.lastValidBlockHeight,
          options,
        );
      },
      {
        ...(options?.retryGuard ? { retryGuard: options.retryGuard } : {}),
        onRetry: (attempt, maxAttempts, message, error) => {
          const { requiredSlot, nodeSlot } = resolveSponsoredRetrySlots(error, {
            lastConfirmedSlot: this._lastConfirmedSlot.get(chainId) ?? null,
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
   * Neither side's lag is pinned to a slot: alchemy_requestFeePayer accepts no
   * minContextSlot (its simulation is the sponsorship policy gate), and we
   * send none on broadcast either — preflight runs at "confirmed" instead (see
   * broadcastAndConfirm). A lagging node therefore surfaces as an ordinary
   * retryable simulation failure, which this retry loop rides out with a fresh
   * blockhash per attempt.
   */
  private async sendSponsoredTransaction(
    chainId: number,
    instructions: SolanaInstructionLike[],
    options?: SendInstructionsOptions,
  ): Promise<string> {
    // Slot our read RPC was at when the current attempt's blockhash was
    // fetched — the state the sponsor's simulation node has not caught up
    // to yet when a retryable lag error occurs.
    let lastSeenSlot: bigint | null = null;

    return withFeePayerRetry(
      async () => {
        // 1. Fresh blockhash + build tx with user as placeholder fee payer
        //    (Alchemy replaces it + prefunds CPI rent).
        const { context, value: latestBlockhash } = await this.getRpc(chainId)
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
        const sponsoredBase64 = await this.requestFeePayer(
          chainId,
          unsignedBase64,
        );

        // 3. Sign with Privy (user's signature).
        const signedBase64 =
          await this.signTransactionViaPrivy(sponsoredBase64);

        // 4. Broadcast + confirm.
        return this.broadcastAndConfirm(
          chainId,
          signedBase64,
          latestBlockhash.lastValidBlockHeight,
          options,
        );
      },
      {
        ...(options?.retryGuard ? { retryGuard: options.retryGuard } : {}),
        onRetry: (attempt, maxAttempts, message, error) => {
          const { requiredSlot, nodeSlot } = resolveSponsoredRetrySlots(error, {
            lastConfirmedSlot: this._lastConfirmedSlot.get(chainId) ?? null,
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
  // sendSponsoredSignedTransaction — EVM-paymaster parity for a SERVER-BUILT tx
  // -------------------------------------------------------------------------

  /**
   * Sponsor + sign + broadcast a transaction the CALLER already built. This is
   * the Solana analog of the EVM adapter attaching the Alchemy paymaster on
   * sendCalls: the caller (the trading planner) builds the swap tx with the
   * user as a PLACEHOLDER fee payer and a fresh blockhash, and here we swap
   * Alchemy in as the fee payer (alchemy_requestFeePayer — its sig + CPI-rent
   * prefund), add the user's Privy signature, and broadcast. A zero-SOL wallet
   * trades gasless; the CLI is a pure signer/submitter, the planner never
   * touches sponsorship.
   *
   * SPONSORSHIP-ONLY: there is no self-pay fallback. If the proxy/policy is
   * absent or the sponsor refuses after retries, this throws — the caller
   * re-quotes rather than silently billing the user's SOL.
   *
   * Unlike sendSponsoredTransaction(instructions), the tx is prebuilt so its
   * blockhash is fixed: a retry re-runs requestFeePayer→sign→broadcast on the
   * SAME bytes (valid within the blockhash's ~60s window) to ride out sponsor
   * simulation / broadcast slot lag. Because no retry can refresh the
   * blockhash, an "expired" confirmation is terminal (retryExpired: false) —
   * the caller rebuilds the tx instead.
   *
   * options.lastValidBlockHeight is the expiry height of the blockhash baked
   * into the tx — pass it whenever the builder has it. When omitted, expiry
   * polling is bounded by the validity window of the CURRENT tip at the first
   * attempt: a strict upper bound (the tx's blockhash is older than the tip),
   * so "expired" stays definitive, at the cost of over-polling a dropped tx
   * by roughly the tx's pre-submission age.
   */
  public async sendSponsoredSignedTransaction(
    chainId: number,
    serializedTransaction: string,
    options?: SendInstructionsOptions & { lastValidBlockHeight?: bigint },
  ): Promise<string> {
    if (
      !this._sponsored ||
      !this._rpcProxyUrls.has(chainId) ||
      !this._getAuthToken
    ) {
      throw new Error(
        "sendSponsoredSignedTransaction requires sponsorship (a proxied RPC + auth token) — no self-pay fallback",
      );
    }

    let lastSeenSlot: bigint | null = null;
    // Confirmation bound for the tx's FIXED blockhash — resolved once and
    // held across retries. Re-reading the tip's lastValidBlockHeight on every
    // attempt would slide the expiry window forward each retry and keep
    // polling a transaction that is already provably dropped.
    let confirmUntilHeight: bigint | undefined = options?.lastValidBlockHeight;

    return withFeePayerRetry(
      async () => {
        // One read: our RPC's current slot (to diagnose a sponsor/broadcast lag
        // error) + the first-attempt fallback confirmation bound. The tx
        // carries its OWN blockhash — we do not rebuild it here.
        const { context, value: latest } = await this.getRpc(chainId)
          .getLatestBlockhash()
          .send();
        lastSeenSlot = context.slot;
        confirmUntilHeight ??= latest.lastValidBlockHeight;

        // 1. Sponsor: Alchemy replaces the placeholder fee payer + signs.
        const sponsoredBase64 = await this.requestFeePayer(
          chainId,
          serializedTransaction,
        );

        // 2. Privy co-signs — the tx now carries the Alchemy fee-payer sig AND
        //    the user's sig (two required signers, distinct slots).
        const signedBase64 =
          await this.signTransactionViaPrivy(sponsoredBase64);

        // 3. Broadcast + confirm.
        return this.broadcastAndConfirm(
          chainId,
          signedBase64,
          confirmUntilHeight,
          options,
        );
      },
      {
        // Fixed bytes: an expired blockhash can never land on a retry.
        retryExpired: false,
        ...(options?.retryGuard ? { retryGuard: options.retryGuard } : {}),
        onRetry: (attempt, maxAttempts, message, error) => {
          const { requiredSlot, nodeSlot } = resolveSponsoredRetrySlots(error, {
            lastConfirmedSlot: this._lastConfirmedSlot.get(chainId) ?? null,
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
    chainId: number,
    encodedTx: string,
    lastValidBlockHeight: bigint,
    options?: {
      preflightCommitment?: Commitment;
      skipPreflight?: boolean;
    },
  ): Promise<string> {
    let signature: Signature;
    try {
      signature = await this.getRpc(chainId)
        .sendTransaction(encodedTx as any, {
          encoding: "base64",
          preflightCommitment:
            options?.preflightCommitment ?? this._preflightCommitment,
          skipPreflight: options?.skipPreflight ?? false,
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

    const { slot } = await confirmTransaction(
      this.getRpc(chainId),
      signature,
      lastValidBlockHeight,
      { stringifyErr: stringifyBigIntSafe },
    );
    this._lastConfirmedSlot.set(chainId, slot);
    return signature;
  }
}
