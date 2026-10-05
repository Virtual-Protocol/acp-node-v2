import {
  compressTransactionMessageUsingAddressLookupTables,
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
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
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
import { createProxyRpcTransport } from "./proxyRpcTransport.js";
import {
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
  type WalletApiRequestSignatureInput,
} from "@privy-io/node";
import {
  ACP_SERVER_URL,
  PRIVY_APP_ID,
  TESTNET_PRIVY_APP_ID,
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_CHAIN_ID_CLUSTERS,
  ACP_CONTRACT_ADDRESSES,
  FUND_TRANSFER_HOOK_ADDRESSES,
  ACP_COMMITMENT,
  MULTI_HOOK_ROUTER_ADDRESSES,
  SUBSCRIPTION_HOOK_ADDRESSES,
  SUBSCRIPTION_STATE_ADDRESSES,
  defaultSplFeeTokens,
} from "../../core/constants.js";
import { ProviderAuthClient } from "../providerAuthClient.js";
import {
  ApprovalRequiredError,
  awaitApproval,
} from "../../core/approvalGate.js";
import {
  withFeePayerRetry,
  isComputeBudgetExceededError,
  isOpaqueSimulationRefusal,
} from "./feePayerRetry.js";
import {
  withCuLimit,
  withMaxCuLimit,
  sizedCuLimit,
  BUMP_CU_HEADROOM,
} from "../../core/solana/routerLayout.js";
import { stringifyBigIntSafe } from "../../core/solana/serialization.js";
import { confirmTransaction } from "./txConfirmation.js";
import {
  KoraClient,
  type KoraFeeQuote,
  type KoraPayer,
} from "./koraClient.js";
import {
  buildSplTransferInstructions,
  getSplTokenBalance,
} from "../../core/solana/wallet.js";

// Sponsorship covers ACP actions: batches touching the cluster's ACP program,
// fund-transfer hook, or multi-hook router. The Associated Token Account
// program is included so a standalone ATA-creation tx is sponsored too, since
// router fund splits that into its own tx. Derived per chainId; the ATA
// program id is the same on every cluster.
//
// The Address Lookup Table program is deliberately NOT sponsorable: sponsoring
// a create/extend covers the fee but not the account rent, so it saves nothing
// and adds a create-to-extend lag. Router completes compress against the
// persistent complete ALT instead.
const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const sponsorableCache = new Map<number, ReadonlySet<string>>();

const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// There is deliberately NO prefund logic in this file. The rent prefund is
// sized and inserted server-side; the SDK submits a transaction carrying only
// ACP instructions and signs whatever comes back.

// Never compress these out of the static keys. An instruction's program needs
// a STATIC account index, so the inserted System transfer needs System static,
// and a pubkey reachable both ways is AccountLoadedTwice at lock validation.
//
// System is eligible for compression at all because it reaches the compressor
// as an ACCOUNT in the router fan-out, never as an invoked program.
const NEVER_COMPRESS: ReadonlySet<string> = new Set([
  SYSTEM_PROGRAM_ID,
  // Zero-cost today (cuLimitIx has `accounts: []` and is the message's own
  // programAddress). Masked so one `ro(COMPUTE_BUDGET)` cannot reintroduce it.
  COMPUTE_BUDGET_PROGRAM_ID,
]);

// Substituted for a masked entry so the map keeps its LENGTH and ORDER — the
// on-wire index is a position in this array, so dropping an entry repoints
// every later account. Never passed as an account by any ACP instruction.
const ALT_MASK_PLACEHOLDER = "AddressLookupTab1e1111111111111111111111111";

/**
 * Compresses against the caller's lookup tables, keeping NEVER_COMPRESS
 * addresses static at +31 bytes each.
 *
 * Applied on every path, not just sponsored ones: keeping System static is
 * always safe, and a `lookupTables` send can fall through to self-pay.
 */
export function compressPreservingSponsorStatics<T>(
  message: T,
  lookupTables: NonNullable<SendInstructionsOptions["lookupTables"]>,
): T {
  const masked = Object.fromEntries(
    Object.entries(lookupTables).map(([lut, addresses]) => [
      lut,
      // Keyed on ADDRESS, not position: the mask stays correct if the source
      // list is ever reordered or extended. `.map` preserves length and order.
      addresses.map((a) =>
        NEVER_COMPRESS.has(a as string) ? ALT_MASK_PLACEHOLDER : a,
      ),
    ]),
  );
  return compressTransactionMessageUsingAddressLookupTables(
    message as never,
    masked as never,
  ) as T;
}

/**
 * Applies the caller's lookup tables and extra signers to a message.
 * Compression must happen before any size check, since a router `complete`
 * fits only once compressed.
 */
function applySendOptions<T>(
  message: T,
  options?: SendInstructionsOptions,
): T {
  let m = message as never;
  if (options?.extraSigners?.length) {
    m = addSignersToTransactionMessage(options.extraSigners as never, m);
  }
  if (options?.lookupTables && Object.keys(options.lookupTables).length > 0) {
    m = compressPreservingSponsorStatics(m, options.lookupTables);
  }
  return m as T;
}

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
        ATA_PROGRAM_ID,
      ].filter((a): a is string => a !== undefined && a !== ""),
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
   * Commitment every send's preflight simulation runs at, overridable per
   * call. Defaults to ACP_COMMITMENT so preflight simulates against the same
   * state the transaction was built on; the RPC's own default trails it.
   */
  preflightCommitment?: Commitment;
  /**
   * Called when a sponsored send is retried due to sponsor-node lag, replacing
   * the default console notice. `slot` is the read RPC's slot at blockhash
   * fetch, `requiredSlot` the slot the sponsor node must reach, `nodeSlot` the
   * lagging node's own slot when an error exposes it, and `rawError` the
   * underlying failure.
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
   * Kora paymaster JSON-RPC URL per chainId, reached through the ACP server
   * proxy. When set for a chain, non-ACP transactions there are paid in SPL
   * rather than self-paying SOL. Pass `{}` or omit a chain to disable it.
   */
  koraRpcUrls?: Record<number, string>;
  /**
   * Who pays for ACP actions: "alchemy" (default) rewrites the fee payer and
   * prefunds rent; "kora" co-signs instead, never modifying the transaction.
   */
  acpSponsorship?: "alchemy" | "kora";
  /** Sponsor-node URL per chain. Defaults to the backend's sponsor proxy. */
  koraSponsorRpcUrls?: Record<number, string>;
  /**
   * SPL fee-token mints to try, in priority order, for Kora-paid transactions.
   * Defaults to `defaultSplFeeTokens(chainId)`; the first tier the wallet can
   * cover wins.
   */
  splFeeTokens?: Record<number, string[]>;
}

// Extracts the responding node's slot from an error chain, when one is
// carried as `contextSlot`. Only a minimum-context-slot error does, and we no
// longer send minContextSlot ourselves, so this is usually null.
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
 *   - `nodeSlot`: the responding node's slot, usually null.
 *   - `requiredSlot`: the slot the failing step needed to reach. Sponsor and
 *     broadcast failures carry no slot, so this is the last confirmed slot,
 *     falling back to the read RPC's blockhash slot.
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

/**
 * Human-readable warning for a sponsored-transaction retry. Slots are named
 * only when the error revealed both; none is invented otherwise.
 */
export function formatSponsoredRetryWarning(
  requiredSlot: bigint | null,
  nodeSlot: bigint | null,
  attempt: number,
  maxAttempts: number,
): string {
  return requiredSlot != null && nodeSlot != null && requiredSlot > nodeSlot
    ? `[gas_sponsorship] sponsor node ${requiredSlot - nodeSlot} slot(s) behind required slot ${requiredSlot} (attempt ${attempt}/${maxAttempts})`
    : `[gas_sponsorship] sponsor node behind recent state, retrying (attempt ${attempt}/${maxAttempts})`;
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

/**
 * The fee payer a compiled transaction names, as base58 — always static
 * account 0. Used to pin `signer_key` on every Kora signTransaction, since a
 * rotating signer pool can otherwise sign with a payer the transaction never
 * named.
 *
 * Reading it back off the TRANSACTION is what makes this structural: whoever
 * the bytes name is who must sign, however the payer was chosen.
 */
function feePayerOf(serializedTransaction: string): string | undefined {
  try {
    const tx = getTransactionDecoder().decode(
      Buffer.from(serializedTransaction, "base64"),
    );
    const compiled = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    const payer = compiled.staticAccounts[0];
    return payer ? String(payer) : undefined;
  } catch {
    // Never block a send on this: unpinned is correct on a single-signer node.
    return undefined;
  }
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
 * Deliberately NOT caught as a fallback. Mirrors the EVM error.
 */
export class InsufficientFeeTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientFeeTokenError";
  }
}

/**
 * Warning for a sponsored router action whose prefund came back empty, which
 * can mean the signer wallet pays the hook PDA rents. Surfaced up front rather
 * than left to fail on-chain. Null when there is nothing to warn about.
 */
export function routerPrefundWarning(
  chainId: number,
  instructions: readonly SolanaInstructionLike[],
  prefundLamports: bigint | null,
  hookRentPreCreated = false,
): string | null {
  // Hook-PDA rents were pre-created in their own tx, so a zero prefund here
  // is the expected success signal.
  if (hookRentPreCreated) return null;
  if (prefundLamports != null && prefundLamports > 0n) return null;
  const router = MULTI_HOOK_ROUTER_ADDRESSES[chainId];
  if (!router) return null;
  const touchesRouter = instructions.some(
    (ix) =>
      (ix.programAddress as string) === router ||
      ix.accounts.some((a) => (a.address as string) === router),
  );
  if (!touchesRouter) return null;
  return (
    "[gas_sponsorship] prefund returned 0 for a router action — hook PDA " +
    "rents (deep CPI) may be paid by the signer wallet if they were not " +
    "pre-created"
  );
}

/**
 * Rewraps a sendTransaction rejection carrying simulation logs so the actual
 * tx-level failure reason survives, not just the often all-success preflight
 * logs. Null when the error has no logs.
 */
export function formatPreflightFailure(err: unknown): Error | null {
  const errObj = err as Record<string, unknown>;
  const context = errObj?.context as Record<string, unknown> | undefined;
  const cause = errObj?.cause as Record<string, unknown> | undefined;
  const logs =
    (context?.logs as string[]) ??
    (cause?.logs as string[]) ??
    (errObj?.logs as string[]);
  if (!logs?.length) return null;
  const reason =
    (cause?.message as string) ??
    (errObj?.message as string) ??
    stringifyBigIntSafe(errObj?.cause ?? context ?? errObj);
  return new Error(
    `Transaction preflight failed [${reason}]:\n${logs.join("\n")}`,
  );
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

  // Gas sponsorship (policy injected server-side). Only chains with an entry
  // in _rpcProxyUrls are sponsored.
  private readonly _rpcProxyUrls: Map<number, string>;
  private _getAuthToken: (() => Promise<string>) | null = null;
  private readonly _sponsored: boolean;
  private readonly _onSponsoredRetry: PrivySolanaConfig["onSponsoredRetry"];
  private readonly _preflightCommitment: Commitment;
  // Slot of the most recently confirmed transaction per chain — the slot the
  // sponsor node must reach to see the previous step's account state.
  // Per-chain because clusters are unrelated slot streams.
  private readonly _lastConfirmedSlot = new Map<number, bigint>();

  // Kora SPL-paid path, registered per chain only where a Kora URL was
  // configured. _splFeeTokens is the per-chain tier list; the resolved payer
  // is cached per chain.
  private readonly _koraClients: Map<number, KoraClient>;
  /** Sponsor node per chain. Empty unless acpSponsorship === "kora". */
  private readonly _koraSponsorClients: Map<number, KoraClient>;
  /** Sponsor payer, cached per chain — one signer per node, so it is stable. */
  private readonly _koraSponsorPayer = new Map<number, KoraPayer>();
  private readonly _splFeeTokens: Map<number, string[]>;
  private readonly _koraPayer = new Map<number, KoraPayer>();
  private readonly _feeTokenDecimals = new Map<string, number>();
  // chainId -> the mints the node accepts as fee payment. Cached for the
  // process lifetime, since the node's allowed list is static per deployment.
  private readonly _nodeFeeTokens = new Map<number, string[]>();

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
    koraSponsorClients: Map<number, KoraClient>;
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
    this._koraSponsorClients = params.koraSponsorClients;
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
    // The app id is signed over and replayed by the server under its own, so
    // a mismatch is rejected and degrades to a silent self-pay fallback.
    // Defaulting by cluster keeps both ends agreeing without an override.
    const privyAppId =
      params.privyAppId ??
      (SOLANA_CHAIN_ID_CLUSTERS[chainIds[0]!] === "devnet"
        ? TESTNET_PRIVY_APP_ID
        : PRIVY_APP_ID);
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
    const koraSponsorClients = new Map<number, KoraClient>();
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

      // Kora SPL-paid path. An undefined `koraRpcUrls` defaults the URL on for
      // every proxied chain; a provided map opts in per chain. Registered only
      // with a fee-token mint configured, so `has(chainId)` means usable.
      const koraUrl =
        params.koraRpcUrls === undefined
          ? `${serverUrl}/wallets/solana-kora-rpc/${chainId}`
          : params.koraRpcUrls[chainId];
      // The SPONSOR node is a different node from the microgas one, since
      // price type is per-node. Registered only when ACP sponsorship is Kora.
      if (params.acpSponsorship === "kora") {
        const sponsorUrl =
          params.koraSponsorRpcUrls === undefined
            ? `${serverUrl}/wallets/solana-kora-sponsor-rpc/${chainId}`
            : params.koraSponsorRpcUrls[chainId];
        if (sponsorUrl) {
          koraSponsorClients.set(
            chainId,
            new KoraClient({ url: sponsorUrl, getToken: token }),
          );
        }
      }

      if (koraUrl) {
        const tiers =
          params.splFeeTokens?.[chainId] ?? defaultSplFeeTokens(chainId);
        if (tiers.length > 0) {
          koraClients.set(chainId, new KoraClient({ url: koraUrl, getToken: token }));
          splFeeTokens.set(chainId, tiers);
        }
      }

      const transport = createProxyRpcTransport(proxyUrl, token);
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
      koraSponsorClients,
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

  /**
   * The microgas Kora client for a chain, or undefined when Kora is not
   * configured there. Exposed so callers can ask the node about its own fee
   * payer and payment address rather than configuring those separately.
   *
   * This is the MARGIN-PRICED microgas node, not the sponsor node.
   */
  getKoraClient(chainId: number): KoraClient | undefined {
    return this._koraClients.get(chainId);
  }

  // -------------------------------------------------------------------------
  // Gas sponsorship: alchemy_requestFeePayer
  // -------------------------------------------------------------------------

  private async requestFeePayer(
    chainId: number,
    serializedTransaction: string,
  ): Promise<{
    serializedTransaction: string;
    prefundLamports: bigint | null;
  }> {
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
    // prefundLamports is returned when prefundRent is true, and absent when
    // no simulation ran.
    const rawPrefund = json.result.prefundLamports;
    return {
      serializedTransaction: json.result.serializedTransaction,
      prefundLamports: rawPrefund != null ? BigInt(rawPrefund) : null,
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
    chainId: number,
    instructions: SolanaInstructionLike[],
    options?: SendInstructionsOptions,
  ): Promise<string> {
    // Lookup-table and multi-signer sends self-pay by default, unless the
    // caller opts in via sponsorLookupTables. See SendInstructionsOptions.
    const hasExtraSigners = (options?.extraSigners?.length ?? 0) > 0;
    const hasLookupTables =
      Object.keys(options?.lookupTables ?? {}).length > 0;
    const needsSelfPay =
      !options?.sponsorLookupTables && (hasExtraSigners || hasLookupTables);

    // Sponsorship applies only to ACP actions; everything else is self-paid.
    const sponsorable = sponsorableProgramIds(chainId);
    const isAcpAction = instructions.some((ix) =>
      sponsorable.has(ix.programAddress as string),
    );
    const useSponsorship =
      !needsSelfPay &&
      this._sponsored &&
      this._rpcProxyUrls.has(chainId) &&
      !!this._getAuthToken &&
      isAcpAction;

    if (useSponsorship) {
      // Same ACP traffic, a different sponsor — see
      // sendKoraSponsoredTransaction.
      if (this._koraSponsorClients.has(chainId)) {
        return this.sendKoraSponsoredTransaction(chainId, instructions, options);
      }
      // The sponsored path does not size its own limit, so the bump's
      // re-measurement happens here before the retry is submitted; a failed
      // one leaves the ceiling withCuBump authored.
      return this.withCuBump(instructions, async (ixs, bump) => {
        const send = bump
          ? await this.resizeForBump(chainId, ixs, options)
          : ixs;
        return this.sendSponsoredTransaction(chainId, send, options);
      });
    }

    // Non-ACP action: pay fees in SPL where Kora is configured. The cached
    // getPayerSigner probe runs before anything is built or signed, so falling
    // back to self-pay carries no double-send risk. A no-balance failure
    // inside sendSplPaidTransaction throws rather than falling back.
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
        // This attempt re-quotes the fee token before signing, so headroom
        // matters most here.
        return this.withCuBump(instructions, (ixs, bump) =>
          this.sendSplPaidTransaction(chainId, ixs, koraPayer, options, bump),
        );
      }
    }

    // The blockhash is fetched INSIDE the attempt, since a retry following an
    // on-chain failure has already spent the confirmation wait.
    return this.withCuBump(instructions, async (ixs, bump) => {
      const { value: latestBlockhash } = await this.getRpc(chainId)
        .getLatestBlockhash()
        .send();

      return this.sendSelfPayTransaction(
        chainId,
        ixs,
        latestBlockhash,
        options,
        bump,
      );
    });
  }

  /**
   * The instruction list with its compute limit set from a simulation.
   *
   * Probe at the ceiling so the simulation is not itself capped, read the
   * units consumed, and re-declare that plus headroom.
   *
   * `trailingInstructions` are MEASURED but not returned. Callers appending
   * further instructions must pass them, or the limit under-declares.
   *
   * FAILS OPEN: every failure path returns the input untouched. A simulation
   * that ERRORS counts as unmeasured, not as a measurement.
   *
   * `bump` marks the sizing on withCuBump's retry, declared with
   * BUMP_CU_HEADROOM. The input then carries the ceiling, so returning it
   * untouched IS the fall-back-to-ceiling.
   */
  private async sizeCuLimit(params: {
    chainId: number;
    instructions: SolanaInstructionLike[];
    feePayer: Address;
    latestBlockhash: any;
    options?: SendInstructionsOptions | undefined;
    trailingInstructions?: SolanaInstructionLike[] | undefined;
    bump?: boolean | undefined;
  }): Promise<SolanaInstructionLike[]> {
    const { chainId, instructions, feePayer, latestBlockhash, options } =
      params;
    const trailing = params.trailingInstructions ?? [];

    try {
      const probe = applySendOptions(
        pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayer(feePayer, m),
          (m) =>
            setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
          (m) =>
            appendTransactionMessageInstructions(
              [...withMaxCuLimit(instructions), ...trailing],
              m,
            ),
        ),
        options,
      );
      const encoded = Buffer.from(
        getTransactionEncoder().encode(compileTransaction(probe as never)),
      ).toString("base64");

      const { value } = await this.getRpc(chainId)
        .simulateTransaction(encoded as never, {
          encoding: "base64",
          replaceRecentBlockhash: true,
        } as never)
        .send();

      const result = value as { err?: unknown; unitsConsumed?: unknown };
      if (result.err != null) return instructions;

      const units = Number(result.unitsConsumed ?? 0);
      if (!Number.isFinite(units) || units <= 0) return instructions;

      const headroom = params.bump ? BUMP_CU_HEADROOM : undefined;
      return withCuLimit(instructions, sizedCuLimit(units, headroom));
    } catch {
      return instructions;
    }
  }

  /**
   * The bump re-measurement for the sponsored send, whose limit is normally
   * authored server-side.
   *
   * Called with the ceiling-authored retry list from withCuBump. Fetches its
   * own blockhash and sizes with the bump headroom, failing open onto the
   * input. The fee payer is the sponsored build's placeholder; a fee-payer
   * swap does not change consumption.
   */
  private async resizeForBump(
    chainId: number,
    instructions: SolanaInstructionLike[],
    options?: SendInstructionsOptions,
  ): Promise<SolanaInstructionLike[]> {
    try {
      const { value: latestBlockhash } = await this.getRpc(chainId)
        .getLatestBlockhash()
        .send();
      return await this.sizeCuLimit({
        chainId,
        instructions,
        feePayer: this._signer.address,
        latestBlockhash,
        options,
        bump: true,
      });
    } catch {
      return instructions;
    }
  }

  /**
   * Runs a send, and on compute exhaustion re-runs it exactly ONCE.
   *
   * The retry hands the attempt the CEILING plus `bump = true`. The ceiling is
   * the fallback, not the goal: paths that size their own limit re-measure
   * against the drifted state inside the retry, and fail open onto the input,
   * which here carries the ceiling.
   *
   * A bump is a REBUILD, never a resend: raising the limit rewrites the
   * message bytes and voids every signature over them. That is also why
   * compute exhaustion is non-retryable in the fee-payer classifier.
   *
   * Safe to run after an on-chain failure: compute exhaustion is
   * deterministic and terminal.
   */
  private async withCuBump(
    instructions: SolanaInstructionLike[],
    attempt: (
      ixs: SolanaInstructionLike[],
      bump: boolean,
    ) => Promise<string>,
  ): Promise<string> {
    try {
      return await attempt(instructions, false);
    } catch (err) {
      if (!isComputeBudgetExceededError(err)) throw err;
      return attempt(withMaxCuLimit(instructions), true);
    }
  }

  /**
   * Cached Kora fee payer for the SPL-PAID chain (stable per node).
   *
   * Deliberately NOT shard-pinned: this payer is reimbursed by the agent's SPL
   * fee, not by rent coming back, so a pin would couple it to a shard it never
   * receives from. The pin belongs on the sponsored path.
   */
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
   * Standard flow: user pays own fees. Carries any extra required signers
   * (each partial-signs; signTransactionMessageWithSigners merges) and
   * compresses against the supplied lookup tables before signing.
   */
  private async sendSelfPayTransaction(
    chainId: number,
    instructions: SolanaInstructionLike[],
    latestBlockhash: any,
    options?: SendInstructionsOptions,
    bump = false,
  ): Promise<string> {
    const sized = await this.sizeCuLimit({
      chainId,
      instructions,
      feePayer: this._signer.address,
      latestBlockhash,
      options,
      bump,
    });

    let message: any = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(this._signer.address, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions(sized, msg),
      (msg) =>
        addSignersToTransactionMessage(
          [this._signer, ...(options?.extraSigners ?? [])],
          msg,
        ),
    );
    if (options?.lookupTables && Object.keys(options.lookupTables).length > 0) {
      message = compressPreservingSponsorStatics(
        message,
        options.lookupTables,
      );
    }

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
   * Fee-token decimals, cached per (chain, mint), for TransferChecked.
   *
   * Read from the MINT, not the wallet's balance: the balance helper's failure
   * sentinel is itself a legitimate decimals value and cannot be told apart
   * from a real answer. A failed read throws rather than resolving to a guess,
   * and only a successful read is cached.
   */
  private async feeTokenDecimals(
    chainId: number,
    feeToken: string,
  ): Promise<number> {
    const key = `${chainId}:${feeToken}`;
    const cached = this._feeTokenDecimals.get(key);
    if (cached !== undefined) return cached;

    const { value } = await this.getRpc(chainId)
      .getTokenSupply(feeToken as Address)
      .send();
    this._feeTokenDecimals.set(key, value.decimals);
    return value.decimals;
  }

  /**
   * The fee-token tiers to actually try on this chain.
   *
   * The node is asked once per chain and is authoritative on ACCEPTANCE, while
   * the configured list stays authoritative on ORDER:
   *
   *   1. configured tiers the node accepts, in configured order;
   *   2. then any mint the node accepts that the SDK has no opinion about.
   *
   * Step 2 lets a newly accepted token be used without an SDK release, and
   * goes last because the configured order is a deliberate decision.
   *
   * Any failure falls back to the configured tiers: this path is an
   * optimization over self-pay and must not remove tokens that already worked.
   */
  private async resolveFeeTokens(chainId: number): Promise<string[]> {
    const configured = this._splFeeTokens.get(chainId) ?? [];

    let accepted = this._nodeFeeTokens.get(chainId);
    if (accepted === undefined) {
      try {
        accepted = await this._koraClients.get(chainId)!.getSupportedTokens();
      } catch (err) {
        console.warn(
          `[kora] getSupportedTokens failed on chain ${chainId}; using the configured fee tokens: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return configured;
      }
      this._nodeFeeTokens.set(chainId, accepted);

      // Surfaced once per chain, at discovery. Skipped when the node reported
      // nothing, which is a discovery failure rather than a rejection.
      const rejected =
        accepted.length > 0
          ? configured.filter((mint) => !accepted!.includes(mint))
          : [];
      if (rejected.length > 0) {
        console.warn(
          `[kora] chain ${chainId}: configured fee token(s) not accepted by the node, skipping: ${rejected.join(
            ", ",
          )}`,
        );
      }
    }

    if (accepted.length === 0) return configured;

    const acceptedSet = new Set(accepted);
    const configuredSet = new Set(configured);
    return [
      ...configured.filter((mint) => acceptedSet.has(mint)),
      ...accepted.filter((mint) => !configuredSet.has(mint)),
    ];
  }

  /**
   * Pick the first fee token (in resolved priority order) whose balance covers
   * Kora's quote, and return that quote alongside it. Balances are read in
   * parallel; only tokens with a positive balance are quoted. Returns null when
   * no tier is affordable.
   *
   * **Each tier is quoted with its own payment instruction included**, via
   * `encodeWithPayment`: Kora prices the instruction list rather than what it
   * does, so quoting the caller's instructions alone understates the fee.
   *
   * The returned quote is the amount Kora will charge, and the caller pays it
   * directly rather than re-quoting. `TransferChecked` data is fixed-width, so
   * the placeholder payment compiles to the same size as the final one.
   */
  private async selectFeeToken(
    chainId: number,
    koraPayer: KoraPayer,
    encodeWithPayment: (paymentIxs: SolanaInstructionLike[]) => string,
  ): Promise<{ feeToken: string; quote: KoraFeeQuote } | null> {
    const client = this._koraClients.get(chainId)!;
    const tiers = await this.resolveFeeTokens(chainId);
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
      const feeToken = tiers[i]!;
      // Real decimals, not a placeholder: only the compiled SIZE affects the
      // fee, but Kora simulates before pricing, so mismatched decimals abort
      // the quote instead of returning a number.
      //
      // A tier whose decimals cannot be read is skipped rather than allowed to
      // throw, so one unreadable mint does not abort the tiers behind it.
      let probeDecimals: number;
      try {
        probeDecimals = await this.feeTokenDecimals(chainId, feeToken);
      } catch {
        continue;
      }
      const probePaymentIxs = await this.buildKoraPaymentInstructions({
        koraPayer,
        feeToken,
        // Placeholder amount only; the quote depends on size, not value.
        amount: 1n,
        decimals: probeDecimals,
      });
      const quote = await client.estimateTransactionFee(
        encodeWithPayment(probePaymentIxs),
        feeToken,
      );
      if (balances[i]! >= quote.feeInToken) return { feeToken, quote };
    }
    return null;
  }

  /**
   * The SPL payment Kora is owed: a `TransferChecked` of `amount` from the agent
   * wallet to Kora's payment address, preceded by a `CreateIdempotent` for the
   * destination ATA.
   *
   * Kora exposes no payment-instruction RPC, so the client builds this and
   * Kora validates it inside `signTransaction` before co-signing.
   *
   * DO NOT "optimize" the create away when the fee account is known to exist.
   * Kora prices the instruction list rather than what the transaction does, so
   * the create is what the per-transaction fee is charged through.
   */
  private buildKoraPaymentInstructions(params: {
    koraPayer: KoraPayer;
    feeToken: string;
    amount: bigint;
    decimals: number;
  }): Promise<SolanaInstructionLike[]> {
    return buildSplTransferInstructions({
      owner: this._address as Address,
      recipient: params.koraPayer.paymentAddress,
      mint: params.feeToken as Address,
      amount: params.amount,
      decimals: params.decimals,
      payer: params.koraPayer.signerAddress,
    });
  }

  /**
   * SPL-paid flow (per attempt, inside withFeePayerRetry):
   * 1. Fresh blockhash; build tx with Kora's payer as fee payer + the caller's
   *    instructions (Kora's payer is known up front — no placeholder mutation).
   * 2. Pick a fee token the wallet can cover, quoting each tier with its own
   *    payment included (selectFeeToken) — returns the fee token AND the quote
   *    Kora will charge.
   * 3. Rebuild the payment at the quoted amount and real decimals, append it.
   * 4. Privy signs (user sig); Kora co-signs as fee payer.
   * 5. Broadcast + confirm.
   *
   * A fresh blockhash per attempt means retries never reuse a stale one. There
   * is no simulationSlot here, so minContextSlot falls back to our last
   * confirmed slot.
   */
  private async sendSplPaidTransaction(
    chainId: number,
    instructions: SolanaInstructionLike[],
    koraPayer: KoraPayer,
    options?: SendInstructionsOptions,
    bump = false,
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
        // for the quote. Parameterised by the instruction list so the shape can
        // be rebuilt once the compute limit is sized below.
        const baseMessageOf = (ixs: SolanaInstructionLike[]) =>
          pipe(
            createTransactionMessage({ version: 0 }),
            (msg) =>
              setTransactionMessageFeePayer(koraPayer.signerAddress, msg),
            (msg) =>
              setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
            (msg) => appendTransactionMessageInstructions(ixs, msg),
          );
        const baseMessage = baseMessageOf(instructions);
        // The caller's lookup tables and extra signers apply here too, and they
        // must be applied to the SAME message the quote is taken from: Kora
        // prices the compiled instruction list, so quoting an uncompressed
        // message and sending a compressed one would charge for a transaction
        // that was never sent.
        const withOptions = (paymentIxs: SolanaInstructionLike[]) =>
          applySendOptions(
            appendTransactionMessageInstructions(paymentIxs, baseMessage),
            options,
          );
        const encodeWithPayment = (paymentIxs: SolanaInstructionLike[]) =>
          Buffer.from(
            getTransactionEncoder().encode(
              compileTransaction(withOptions(paymentIxs)),
            ),
          ).toString("base64");

        // Each tier is quoted with its payment included, so `quote` is what Kora
        // will charge — no re-quote, and no window where the affordability check
        // and the charge disagree.
        const selection = await this.selectFeeToken(
          chainId,
          koraPayer,
          encodeWithPayment,
        );
        if (!selection) {
          throw new InsufficientFeeTokenError(
            "Not enough balance to cover the network fee. Add USDC, USDT, or VIRTUAL to your wallet and try again.",
          );
        }
        const { feeToken, quote } = selection;

        const decimals = await this.feeTokenDecimals(chainId, feeToken);
        const finalPaymentIxs = await this.buildKoraPaymentInstructions({
          koraPayer,
          feeToken,
          amount: quote.feeInToken,
          decimals,
        });

        // Sized AFTER the payment instructions exist and measured WITH them,
        // since they consume real compute. Safe to resize after quoting: with
        // no SetComputeUnitPrice attached the limit does not affect the fee.
        const sizedInstructions = await this.sizeCuLimit({
          chainId,
          instructions,
          feePayer: koraPayer.signerAddress,
          latestBlockhash,
          options,
          trailingInstructions: finalPaymentIxs,
          bump,
        });

        // Append the payment instruction, recompile, and collect signatures:
        // the user's (Privy) then Kora's (fee payer).
        const finalMessage = applySendOptions(
          appendTransactionMessageInstructions(
            finalPaymentIxs,
            baseMessageOf(sizedInstructions),
          ),
          options,
        );
        const finalBase64 = Buffer.from(
          getTransactionEncoder().encode(compileTransaction(finalMessage)),
        ).toString("base64");

        const userSigned = await this.signTransactionViaPrivy(finalBase64);
        const payerKey = feePayerOf(userSigned);
        const fullySigned = await client.signTransaction(
          userSigned,
          payerKey ? { signerKey: payerKey } : undefined,
        );

        return this.broadcastAndConfirm(
          chainId,
          fullySigned,
          latestBlockhash.lastValidBlockHeight,
          options,
        );
      },
      {
        ...(options?.retryGuard ? { retryGuard: options.retryGuard } : {}),
        ...(options?.expectedErrors
          ? { expectedErrors: options.expectedErrors }
          : {}),
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
   * ACP action sponsored by the Kora SPONSOR node.
   *
   * Differs from the Alchemy path in one decisive way: Kora only ever appends
   * a signature, never rewriting the transaction, so the fee payer is chosen
   * up front and the rent prefund is written before it arrives.
   *
   * The prefund exists because no ACP instruction takes a payer account, so
   * PDA rent falls on the acting wallet.
   *
   * Sizing is by simulation rather than by inspecting instructions, which
   * makes it depth-independent in the CPI stack.
   */
  private async sendKoraSponsoredTransaction(
    chainId: number,
    instructions: SolanaInstructionLike[],
    options?: SendInstructionsOptions,
  ): Promise<string> {
    // Submits with no ComputeBudget content and signs whatever comes back, so
    // the cuLimitIx the clients attach for other flows is dropped here.
    const bareInstructions = instructions.filter(
      (ix) => (ix.programAddress as string) !== COMPUTE_BUDGET_PROGRAM_ID,
    );
    try {
      return await this.sendKoraSponsoredAttempt(
        chainId,
        bareInstructions,
        options,
        false,
      );
    } catch (err) {
      // Backstop for a compute limit that proved too small: one re-run at the
      // maximum limit. Non-compute failures rethrow.
      if (!isComputeBudgetExceededError(err)) throw err;
      return this.sendKoraSponsoredAttempt(
        chainId,
        bareInstructions,
        options,
        true,
      );
    }
  }

  private async sendKoraSponsoredAttempt(
    chainId: number,
    instructions: SolanaInstructionLike[],
    options: SendInstructionsOptions | undefined,
    forceMaxCuLimit: boolean,
  ): Promise<string> {
    const client = this._koraSponsorClients.get(chainId);
    if (!client) {
      throw new Error(`No Kora sponsor client configured for chain ${chainId}`);
    }
    const rpc = this.getRpc(chainId);
    let lastSeenSlot: bigint | null = null;

    return withFeePayerRetry(
      async () => {
        const payer = await this.resolveKoraSponsorPayer(
          chainId,
          options?.sponsorShard,
        );
        const { context, value: latestBlockhash } = await rpc
          .getLatestBlockhash()
          .send();
        lastSeenSlot = context.slot;

        const unfundedBase64 = Buffer.from(
          getTransactionEncoder().encode(
            compileTransaction(
              applySendOptions(
                pipe(
                  createTransactionMessage({ version: 0 }),
                  (m) => setTransactionMessageFeePayer(payer.signerAddress, m),
                  (m) =>
                    setTransactionMessageLifetimeUsingBlockhash(
                      latestBlockhash,
                      m,
                    ),
                  (m) => appendTransactionMessageInstructions(instructions, m),
                ),
                options,
              ),
            ),
          ),
        ).toString("base64");

        // The SDK submits unfunded bytes and never authors a transfer out of
        // the sponsor. The returned bytes are signed EXACTLY as received, so
        // any retry re-runs this call rather than rebuilding locally.
        let finalBase64: string;
        try {
          ({ transaction: finalBase64 } =
            await client.prepareSponsoredTransaction(
              unfundedBase64,
              forceMaxCuLimit ? { forceMaxCuLimit: true } : undefined,
            ));
        } catch (err) {
          throw await this.explainOpaqueSimulationRefusal(
            chainId,
            unfundedBase64,
            err,
          );
        }

        const userSigned = await this.signTransactionViaPrivy(finalBase64);
        // Read off the PREPARED bytes: the rewrite that happens by here is
        // where the fee payer is set at all on this path.
        const payerKey = feePayerOf(userSigned);
        let fullySigned: string;
        try {
          fullySigned = await client.signTransaction(
            userSigned,
            payerKey ? { signerKey: payerKey } : undefined,
          );
        } catch (err) {
          // `userSigned`, not `unfundedBase64`: re-simulating the pre-prepare
          // bytes would explain a transaction nobody sent.
          throw await this.explainOpaqueSimulationRefusal(
            chainId,
            userSigned,
            err,
          );
        }

        return this.broadcastAndConfirm(
          chainId,
          fullySigned,
          latestBlockhash.lastValidBlockHeight,
          options,
        );
      },
      {
        ...(options?.retryGuard ? { retryGuard: options.retryGuard } : {}),
        ...(options?.expectedErrors
          ? { expectedErrors: options.expectedErrors }
          : {}),
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
          // Same line the other sponsored legs print, so a run's retry count
          // is measurable here too instead of reading zero by construction.
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
   * Re-attaches the program logs a sponsor swallowed.
   *
   * A sponsor may refuse with no program, error code, or logs, leaving every
   * downstream caller blind to WHY the send failed. The transaction is ours,
   * so our own RPC simulates it: `sigVerify: false` because the bytes are
   * unsigned here, `replaceRecentBlockhash: true` because the blockhash may
   * have moved on.
   *
   * FAILS OPEN in both directions. A refusal already carrying a reason is
   * returned untouched, and a failed simulation returns the original error
   * unchanged, keeping it as `cause` so existing matches still fire.
   */
  private async explainOpaqueSimulationRefusal(
    chainId: number,
    transactionBase64: string,
    err: unknown,
  ): Promise<unknown> {
    if (!isOpaqueSimulationRefusal(err)) return err;
    try {
      const { value } = await this.getRpc(chainId)
        .simulateTransaction(transactionBase64 as never, {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: true,
        } as never)
        .send();
      const logs = (value as { logs?: string[] | null })?.logs;
      if (!logs || logs.length === 0) return err;
      const original = err instanceof Error ? err.message : String(err);
      const explained = new Error(
        `${original}\nlocal simulation logs (sponsor returned none):\n${logs.join("\n")}`,
      );
      // Assigned rather than passed to the constructor: `cause` as a
      // constructor option needs a higher lib target than this file uses.
      (explained as { cause?: unknown }).cause = err;
      return explained;
    } catch {
      return err;
    }
  }

  /** The sponsor node has one signer, so its payer is stable and cacheable. */
  /**
   * Kora fee payer for the SPONSORED path.
   *
   * `preferred` pins it to the job's rent shard, so the wallet that prefunds a
   * job's accounts is the one its rent returns to. Without it the payer is
   * whichever wallet the rotation last handed out.
   *
   * The pinned value is not cached, since the cache holds one entry per chain
   * and per-job picks would only thrash it.
   *
   * `paymentAddress` follows the signer when Kora reports no distinct one;
   * carrying the rotation's value across would name a different wallet.
   */
  private async resolveKoraSponsorPayer(
    chainId: number,
    preferred?: Address,
  ): Promise<KoraPayer> {
    if (preferred) {
      const rotation = await this.resolveKoraSponsorPayer(chainId);
      const paymentAddress =
        rotation.paymentAddress === rotation.signerAddress
          ? preferred
          : rotation.paymentAddress;
      return { signerAddress: preferred, paymentAddress };
    }
    const cached = this._koraSponsorPayer.get(chainId);
    if (cached) return cached;
    const client = this._koraSponsorClients.get(chainId);
    if (!client) {
      throw new Error(`No Kora sponsor client configured for chain ${chainId}`);
    }
    const payer = await client.getPayerSigner();
    this._koraSponsorPayer.set(chainId, payer);
    return payer;
  }

  /**
   * NO sizeCuLimit here, deliberately: this path submits UNSIGNED bytes, so
   * the limit is sized upstream for every SDK version. The legs that sign
   * first (SPL-paid, self-pay) have no such option and size themselves.
   *
   * withCuBump still wraps this call: an upstream that declines to size, or
   * sizes too low, is caught by the same backstop as everywhere else. The
   * bump retry arrives already re-measured (resizeForBump in the caller's
   * closure), with the ceiling underneath if that measurement failed — this
   * relies on the upstream sizer keeping a limit the transaction already
   * declares, the same assumption the ceiling backstop has always made.
   */
  private async sendSponsoredTransaction(
    chainId: number,
    instructions: SolanaInstructionLike[],
    options?: SendInstructionsOptions,
  ): Promise<string> {
    // Slot our read RPC was at when this attempt's blockhash was fetched.
    let lastSeenSlot: bigint | null = null;

    return withFeePayerRetry(
      async () => {
        // 1. Fresh blockhash + build tx with user as placeholder fee payer
        //    (the sponsor replaces it and prefunds rent).
        const { context, value: latestBlockhash } = await this.getRpc(chainId)
          .getLatestBlockhash()
          .send();
        lastSeenSlot = context.slot;

        let message: any = pipe(
          createTransactionMessage({ version: 0 }),
          (msg) => setTransactionMessageFeePayer(this._signer.address, msg),
          (msg) =>
            setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
          (msg) => appendTransactionMessageInstructions(instructions, msg),
        );

        // Compress against the caller's lookup table before the fee-payer
        // request; table propagation lag is absorbed by the retry.
        if (
          options?.sponsorLookupTables &&
          options.lookupTables &&
          Object.keys(options.lookupTables).length > 0
        ) {
          message = compressPreservingSponsorStatics(
            message,
            options.lookupTables,
          );
        }

        const compiled = compileTransaction(message);
        const wireBytes = getTransactionEncoder().encode(compiled);
        const unsignedBase64 = Buffer.from(wireBytes).toString("base64");

        // 2. Request gas sponsorship.
        const {
          serializedTransaction: sponsoredBase64,
          prefundLamports,
        } = await this.requestFeePayer(chainId, unsignedBase64);
        const prefundWarning = routerPrefundWarning(
          chainId,
          instructions,
          prefundLamports,
          options?.hookRentPreCreated ?? false,
        );
        if (prefundWarning) console.warn(prefundWarning);

        // 3. Sign with Privy (user's signature).
        let signedBase64 = await this.signTransactionViaPrivy(sponsoredBase64);

        // 3b. Multi-signer: each extra required signer partial-signs the
        //     already-signed tx, filling only its own slot.
        if ((options?.extraSigners?.length ?? 0) > 0) {
          let tx: any = getTransactionDecoder().decode(
            new Uint8Array(Buffer.from(signedBase64, "base64")),
          );
          for (const signer of options!.extraSigners!) {
            const [sigDict] = await signer.signTransactions([tx]);
            tx = { ...tx, signatures: { ...tx.signatures, ...sigDict } };
          }
          signedBase64 = getBase64EncodedWireTransaction(tx);
        }

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
        ...(options?.expectedErrors
          ? { expectedErrors: options.expectedErrors }
          : {}),
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
   * Sponsor + sign + broadcast a transaction the CALLER already built with a
   * placeholder fee payer and a fresh blockhash. The sponsor is swapped in as
   * fee payer, the user's signature added, and the result broadcast.
   *
   * SPONSORSHIP-ONLY: no self-pay fallback. If the sponsor refuses after
   * retries this throws, so the caller re-quotes rather than billing SOL.
   *
   * The tx is prebuilt, so its blockhash is fixed and a retry re-runs on the
   * SAME bytes. No retry can refresh the blockhash, so an "expired"
   * confirmation is terminal (retryExpired: false).
   *
   * Pass `options.lastValidBlockHeight` whenever the builder has it. Omitted,
   * expiry polling is bounded by the current tip's window — a strict upper
   * bound, so "expired" stays definitive at the cost of over-polling.
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
    // Confirmation bound for the tx's FIXED blockhash, resolved once and held
    // across retries so the expiry window cannot slide forward.
    let confirmUntilHeight: bigint | undefined = options?.lastValidBlockHeight;

    return withFeePayerRetry(
      async () => {
        // One read: our RPC's current slot plus the first-attempt fallback
        // confirmation bound. The tx carries its OWN blockhash.
        const { context, value: latest } = await this.getRpc(chainId)
          .getLatestBlockhash()
          .send();
        lastSeenSlot = context.slot;
        confirmUntilHeight ??= latest.lastValidBlockHeight;

        // 1. Sponsor: Alchemy replaces the placeholder fee payer + signs.
        const { serializedTransaction: sponsoredBase64 } =
          await this.requestFeePayer(chainId, serializedTransaction);

        // 2. Privy co-signs, filling the second required signer slot.
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
        ...(options?.expectedErrors
          ? { expectedErrors: options.expectedErrors }
          : {}),
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
      throw formatPreflightFailure(err) ?? err;
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
