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
// fund-transfer hook, or multi-hook router (batchConfigureHooks targets the
// router program directly). The Associated Token Account program is included
// so a STANDALONE ATA-creation tx is sponsored too — router fund splits ATA
// creation into its own tx to keep the fund tx small (see fundViaRouter), and
// Alchemy's gas policy sponsors ATA-only txs (confirmed via devnet spike).
// Derived per chainId so devnet and mainnet each recognize their own
// deployments; the ATA program id is the same on every cluster.
//
// The Address Lookup Table program is deliberately NOT sponsorable: sponsoring
// an ALT create/extend covers only the tx fee, not the ALT account RENT
// (~0.0084 SOL), which Alchemy's prefundRent doesn't reimburse — so it saves
// nothing and adds a create→extend sponsor-lag. Router completes avoid the
// issue entirely by compressing against the persistent complete ALT, created
// once by the upgrade authority.
const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const sponsorableCache = new Map<number, ReadonlySet<string>>();

const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// There is deliberately NO prefund logic in this file. The rent prefund — a
// System transfer from the sponsor into the acting wallet — is sized and
// INSERTED by the ACP server (`prepareSponsoredTransaction` on the sponsor
// proxy): the SDK submits a transaction carrying only ACP instructions and
// Privy-signs whatever comes back. Probe constants, sizing simulation, and
// System instruction encoding all live server-side, where the caller is
// authenticated and the checks cannot be skipped.

// Never compress these out of the static keys. An instruction's program must
// have a STATIC account index — the runtime bounds program_id_index by the
// static key list — so the inserted System transfer needs System static. Once
// compression has moved System into table space it has to be put back, and the
// same pubkey reachable both ways is AccountLoadedTwice at lock validation.
//
// System is eligible for compression because it reaches the compressor as an
// ACCOUNT, never as an invoked program: `ro(SYSTEM_PROGRAM_ID)` in the router
// fan-out on complete/submit/reject, and the bundled ATA create on fund.
const NEVER_COMPRESS: ReadonlySet<string> = new Set([
  SYSTEM_PROGRAM_ID,
  // Zero-cost today (cuLimitIx has `accounts: []` and is the message's own
  // programAddress). Masked so one `ro(COMPUTE_BUDGET)` cannot reintroduce it.
  COMPUTE_BUDGET_PROGRAM_ID,
]);

// Substituted for a masked entry so the map keeps its LENGTH and ORDER: the
// on-wire index is the address's POSITION in this array, resolved against an
// already-deployed table, so dropping an entry repoints every later account.
// Never passed as an account by any ACP instruction, so it is never matched.
const ALT_MASK_PLACEHOLDER = "AddressLookupTab1e1111111111111111111111111";

/**
 * Compresses against the caller's lookup tables, keeping NEVER_COMPRESS
 * addresses static. Costs +31 bytes per masked address present (System only in
 * practice) — one 32-byte static key for one 1-byte index.
 *
 * Applied on every path, not just sponsored ones: keeping System static is
 * always safe, and a `lookupTables` send falls through to self-pay whenever
 * sponsorship is unavailable.
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
 *
 * Compression must happen before any size check: a router `complete` fits only
 * once compressed, and measuring it uncompressed would reject a transaction
 * that is actually fine.
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
   * Who pays for ACP actions.
   *
   * "alchemy" (default) — alchemy_requestFeePayer rewrites the fee payer and
   * prefunds rent. "kora" — the Kora sponsor node co-signs and the prefund is
   * written here, because Kora never modifies a transaction.
   */
  acpSponsorship?: "alchemy" | "kora";
  /** Sponsor-node URL per chain. Defaults to the backend's sponsor proxy. */
  koraSponsorRpcUrls?: Record<number, string>;
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

/**
 * Human-readable warning for a sponsored-transaction retry. Slots are named
 * only when a -32016 broadcast error revealed both; a sponsor-simulation
 * failure carries no slot information, so no slot is invented for it.
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

/**
 * Warning for a sponsored router action whose prefund came back empty.
 * A sponsor's rent estimator may not cover account creations made deep in the
 * CPI stack: router actions create hook PDAs several calls down, so a zero
 * prefund there can mean the signer wallet pays those rents. Surface it up
 * front instead of letting the transaction die on-chain with a bare
 * "insufficient lamports". Returns null when there is nothing to warn about.
 */
export function routerPrefundWarning(
  chainId: number,
  instructions: readonly SolanaInstructionLike[],
  prefundLamports: bigint | null,
  hookRentPreCreated = false,
): string | null {
  // Hook-PDA rents were pre-created at CPI height 2 in their own sponsored
  // tx — a zero prefund on the main tx is the expected success signal.
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
 * Rewraps a sendTransaction rejection that carries simulation logs so the
 * ACTUAL tx-level failure reason survives, not just the (often all-success)
 * preflight logs: a broadcast can fail post-execution — InsufficientFundsForRent
 * after every instruction succeeded, BlockhashNotFound, an unmet
 * minContextSlot — and without the reason the error reads as a bare
 * "simulation failed" over a wall of success lines. Returns null when the
 * error has no logs (network, auth, server errors pass through unchanged).
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
  /** Sponsor node per chain. Empty unless acpSponsorship === "kora". */
  private readonly _koraSponsorClients: Map<number, KoraClient>;
  /** Sponsor payer, cached per chain — one signer per node, so it is stable. */
  private readonly _koraSponsorPayer = new Map<number, KoraPayer>();
  private readonly _splFeeTokens: Map<number, string[]>;
  private readonly _koraPayer = new Map<number, KoraPayer>();
  private readonly _feeTokenDecimals = new Map<string, number>();
  // chainId -> the mints the node accepts as fee payment (getSupportedTokens).
  // Cached for the process lifetime: allowed_spl_paid_tokens is baked into the
  // Kora image, so it cannot change while this adapter lives.
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
    // The app id is not cosmetic: generatePrivyAuthSig signs over
    // `headers: { "privy-app-id": privyAppId }`, and the ACP server replays that
    // request under ITS OWN app id. Sign with the mainnet id against a testnet
    // server and Privy rejects the signature — surfacing as a 500 from
    // /wallets/solana/sign-message, which the adapter then swallows into a
    // silent self-pay fallback. Defaulting by cluster keeps the two ends
    // agreeing without every devnet caller having to remember the override.
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

      // Kora SPL-paid path for this proxied chain. `koraRpcUrls` undefined =>
      // default the URL on for every proxied chain; a provided map opts in
      // per chain (absent chain => disabled). Only register when at least one
      // fee-token mint is configured, so `_koraClients.has(chainId)` means
      // "Kora is usable here"; otherwise the send path falls back to self-pay.
      const koraUrl =
        params.koraRpcUrls === undefined
          ? `${serverUrl}/wallets/solana-kora-rpc/${chainId}`
          : params.koraRpcUrls[chainId];
      // The SPONSOR node is a different node from the microgas one: price type
      // is a per-node setting, so one is margin-priced and the other free.
      // Registered only when ACP sponsorship is switched to Kora, so the
      // default build has no sponsor client at all.
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
   * The microgas Kora client for a chain, or undefined when kora is not
   * configured for it.
   *
   * Exposed so callers can ask the node about itself — its fee payer and
   * payment address — rather than configuring those values separately and
   * letting them drift from the node actually charging. The client is already
   * authenticated and already points at the deployed route, which is the whole
   * reason to hand it out instead of letting each caller rebuild the URL and
   * re-derive an agent token.
   *
   * This is the MARGIN-PRICED microgas node, not the sponsor node: fees it
   * collects land in `getPayerSigner().paymentAddress`.
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
    // prefundLamports is returned when prefundRent is true — the amount
    // Alchemy's rent-prefunding estimator decided to front (absent when no
    // simulation ran).
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
    // Lookup-table and multi-signer sends self-pay by default, UNLESS the
    // caller opts into Option B (sponsorLookupTables): then the sponsored path
    // compresses against the table (Alchemy resolves it — v0 support) AND
    // carries extra required signers (each partial-signs after Alchemy + Privy;
    // Alchemy sponsors two-signer txs — confirmed via devnet spike). See
    // SendInstructionsOptions.
    const hasExtraSigners = (options?.extraSigners?.length ?? 0) > 0;
    const hasLookupTables =
      Object.keys(options?.lookupTables ?? {}).length > 0;
    const needsSelfPay =
      !options?.sponsorLookupTables && (hasExtraSigners || hasLookupTables);

    // Sponsorship applies only to ACP actions (batches touching this chain's
    // ACP program or hook). Everything else — generic transfers, unrelated
    // instructions — is self-paid.
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
      // Same ACP traffic, a different sponsor. Kora cannot rewrite the fee
      // payer the way Alchemy does — see sendKoraSponsoredTransaction.
      if (this._koraSponsorClients.has(chainId)) {
        return this.sendKoraSponsoredTransaction(chainId, instructions, options);
      }
      // The sponsored path does not size its own limit (the server does, on
      // the unsigned bytes) — so the bump's re-measurement happens here, in
      // the closure, before the retry is submitted. A re-measurement that
      // fails leaves the ceiling withCuBump authored.
      return this.withCuBump(instructions, async (ixs, bump) => {
        const send = bump
          ? await this.resizeForBump(chainId, ixs, options)
          : ixs;
        return this.sendSponsoredTransaction(chainId, send, options);
      });
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
        // This attempt re-quotes the fee token before signing, so a bump is
        // the costliest of the three. Headroom matters most here.
        return this.withCuBump(instructions, (ixs, bump) =>
          this.sendSplPaidTransaction(chainId, ixs, koraPayer, options, bump),
        );
      }
    }

    // The blockhash is fetched INSIDE the attempt: a retry that follows an
    // on-chain failure has already spent the confirmation wait, so reusing
    // the first attempt's blockhash risks resending against an expired one.
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
   * The standard recipe: probe at the ceiling so the simulation is not itself
   * capped by the runtime's 200k-per-instruction default, read the units the
   * run actually consumed, and re-declare that plus headroom. Solana charges
   * the REQUESTED limit against each writable account's per-block budget, so
   * a limit measured this way is worth the round trip on any path whose fee
   * payer is shared.
   *
   * `trailingInstructions` are MEASURED but not returned. Callers that append
   * further instructions after this list (the SPL-paid path appends its fee
   * payment) must pass them, or the limit under-declares by their consumption
   * and every send bumps.
   *
   * FAILS OPEN. Every failure path returns the input untouched, leaving
   * ROUTER_CU_DEFAULT in place — a sizing problem must never cost a caller
   * their send. A simulation that ERRORS is treated as unmeasured rather than
   * as a measurement, because a run that aborted partway under-reports what a
   * complete run consumes. Below this sits withCuBump, which catches a sized
   * limit that still proved too small.
   *
   * `bump` marks the sizing that runs on withCuBump's retry: the standard
   * margin already failed once, so the fresh measurement is declared with
   * BUMP_CU_HEADROOM instead. The fail-open contract is unchanged — on the
   * retry the input arrives carrying the ceiling, so returning it untouched
   * IS the fall-back-to-ceiling.
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
   * The bump re-measurement for a path that has no sizing of its own — the
   * sponsored send, whose limit is normally authored server-side on the
   * unsigned bytes.
   *
   * Called with the ceiling-authored retry list from withCuBump. Fetches its
   * own blockhash (the simulation replaces it anyway; compiling the probe
   * needs one) and sizes with the bump headroom. Everything that can go wrong
   * falls open onto the input, which carries the ceiling — the retry is never
   * lost to a sizing problem. The fee payer is the same placeholder the
   * sponsored build uses; the sponsor rewrites it after our measurement, and
   * a fee-payer swap does not change the instructions' consumption.
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
   * Legs declare ROUTER_CU_DEFAULT rather than the maximum, because Solana
   * charges the REQUESTED limit against each writable account's per-block
   * budget. That trades a certain waste for a rare correction, and this is
   * the correction.
   *
   * The retry hands the attempt the CEILING plus `bump = true`. The ceiling
   * is the fallback, not the goal: paths that size their own limit re-measure
   * against the drifted state inside the retry (sizeCuLimit with `bump`,
   * declaring BUMP_CU_HEADROOM over the fresh measurement), and their
   * fail-open on a broken re-measurement returns the input untouched — which
   * here carries the ceiling, the one value that can never be too small. The
   * exhaustion that triggered the bump proves the drift outran the standard
   * margin, so retrying at the same margin would be a coin flip on the same
   * failure; retrying blind at the ceiling would spend block budget the leg
   * never uses.
   *
   * A bump is a REBUILD, never a resend: raising the limit rewrites the
   * message bytes, which voids every signature over them. That is also why
   * compute exhaustion sits in NON_RETRYABLE_FEE_PAYER_PATTERNS — resending
   * the identical transaction consumes the identical units.
   *
   * Safe to run after an on-chain failure. Compute exhaustion is
   * deterministic and terminal, so the first attempt cannot land late and
   * double-execute alongside the retry.
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
   * Fee-token decimals, cached per (chain, mint). Needed by TransferChecked,
   * which verifies the value against the mint and rejects a mismatch.
   *
   * Read from the MINT, not from the wallet's balance. Decimals are a property
   * of the mint, and the balance helper returns a hardcoded `0` when both of
   * its reads fail — but `0` is itself a legitimate decimals value, so that
   * sentinel cannot be told apart from a real answer. Cached, it would make
   * every later payment in this token fail a decimals check for the lifetime of
   * the process, reporting a mismatch rather than the RPC failure that caused
   * it.
   *
   * So a failed read throws instead of resolving to a guess, and only a
   * successful read is cached — the next send retries.
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
   * Two lists have to agree and are maintained in different repos: the SDK's
   * configured tier list (priority order — which token an agent is charged in
   * first) and the node's `allowed_spl_paid_tokens` (which mints it accepts at
   * all). Left independent they drift both ways: a mint added to kora.toml is
   * unusable until someone edits the SDK, and a mint the SDK lists but the node
   * rejects burns a round trip per transaction and surfaces as an opaque
   * upstream error.
   *
   * So the node is asked once per chain and treated as authoritative on
   * ACCEPTANCE, while the configured list stays authoritative on ORDER:
   *
   *   1. configured tiers the node accepts, in configured order;
   *   2. then any mint the node accepts that the SDK has no opinion about.
   *
   * Step 2 is what lets a token added to kora.toml be used without an SDK
   * release. It goes last because the configured order encodes a deliberate
   * revenue decision and an unknown mint has no place inside it.
   *
   * Any failure — node unreachable, method disabled, empty list — falls back to
   * the configured tiers. This whole path is an optimization over self-pay, so
   * a discovery failure must not remove fee tokens that already worked.
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

      // Surfaced once per chain, at discovery. A silently dropped tier is the
      // failure this method exists to prevent, so it should not be invisible.
      // Skipped when the node reported nothing: that is a discovery failure
      // (handled below), not a statement that every configured mint is bad.
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
   * `encodeWithPayment`. Quoting the caller's instructions alone understates the
   * fee by one ATA rent — the payment always carries a `CreateIdempotent` for
   * Kora's fee account, and Kora prices the instruction list rather than what it
   * does. A wallet holding a balance between the two figures used to pass this
   * check, fail to fund the payment, and abort the send with no fallback to the
   * next tier.
   *
   * The returned quote is therefore the amount Kora will actually charge, and
   * the caller pays it directly rather than re-quoting. `TransferChecked` data
   * is fixed-width, so the placeholder payment compiles to the same size as the
   * final one and the two quotes cannot diverge.
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
      // Real decimals, not a placeholder. Only the compiled SIZE affects the
      // fee, but Kora SIMULATES the transaction before pricing it, so a
      // TransferChecked whose decimals disagree with the mint aborts the quote
      // with MintDecimalsMismatch (custom program error 0x12) instead of
      // returning a number. A `0` placeholder therefore fails against every
      // mint that is not 0-decimal — i.e. all of them in practice.
      //
      // A tier whose decimals cannot be read is skipped rather than allowed to
      // throw: feeTokenDecimals refuses to cache a guess, and one unreadable
      // mint must not abort selection for the tiers behind it.
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
   * Kora exposes no `getPaymentInstruction` RPC (confirmed against
   * `getConfig.enabled_methods` on 2.2.x), so the client builds this and Kora
   * validates it inside `signTransaction` before co-signing.
   *
   * DO NOT "optimize" the create away when the fee account is known to exist.
   * Kora prices the instruction list rather than what the transaction does, so
   * that create is what the platform's per-transaction fee is charged through —
   * omitting it drops revenue on a repeat transfer by ~99.8%. This was
   * implemented once and reverted for exactly that reason. See
   * `deploy/kora/CHANGES.md` in agentic-commerce-be, "ATA creation is the
   * billing mechanism".
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
        // for the fee quote + payment instruction. Parameterised by the
        // instruction list so the same shape can be rebuilt once the compute
        // limit has been sized below.
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

        // Sized AFTER the payment instructions exist, and measured WITH them:
        // they are appended after the caller's list and consume real compute,
        // so a limit measured without them under-declares and every send
        // bumps.
        //
        // Safe to resize after quoting. Kora re-derives the fee it requires
        // from the transaction it is handed, and that fee is the base fee
        // plus price x limit — with no SetComputeUnitPrice attached the limit
        // contributes nothing, so the quoted payment still covers it.
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
  /**
   * ACP action sponsored by the Kora SPONSOR node.
   *
   * The shape differs from the Alchemy path in one decisive way. Alchemy takes
   * the transaction, REWRITES the fee payer, prefunds rent, and hands it back
   * for the user to sign. Kora cannot: it only ever appends a signature, so the
   * transaction has to be correct before it arrives. That means we choose the
   * fee payer up front AND write the rent prefund ourselves.
   *
   * The prefund exists because no ACP instruction takes a payer account — rent
   * for every PDA is welded to the acting wallet (createJob's only writable
   * signer is `client`), and that wallet holds 0 SOL by design.
   *
   * Sizing is by simulation, not by inspecting instructions: a static estimator
   * can miss account creations made deep in the CPI stack, whereas measuring the
   * shortfall is depth-independent — it does not care how deep the account was
   * created.
   */
  private async sendKoraSponsoredTransaction(
    chainId: number,
    instructions: SolanaInstructionLike[],
    options?: SendInstructionsOptions,
  ): Promise<string> {
    // This path does not author its own compute-unit limit: it submits with
    // no ComputeBudget content at all and signs whatever comes back. The
    // cuLimitIx the clients attach for the other flows is dropped here.
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
      // Backstop for a compute limit that proved too small: exactly one
      // re-run of the whole flow, this time requesting the maximum limit.
      // Non-compute failures (blockhash expiry, insufficient funds, policy
      // rejections) rethrow — they already had their retry path.
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
        const payer = await this.resolveKoraSponsorPayer(chainId);
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
        // the sponsor itself. Upstream rejections — oversized wire payloads,
        // transactions that cannot execute — surface here verbatim.
        // The returned bytes are signed EXACTLY as received: no blockhash
        // refresh, no instruction changes — any retry re-runs this call
        // instead of rebuilding locally.
        const { transaction: finalBase64 } =
          await client.prepareSponsoredTransaction(
            unfundedBase64,
            forceMaxCuLimit ? { forceMaxCuLimit: true } : undefined,
          );

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
          }
        },
      },
    );
  }

  /** The sponsor node has one signer, so its payer is stable and cacheable. */
  private async resolveKoraSponsorPayer(chainId: number): Promise<KoraPayer> {
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
   * NO sizeCuLimit here, deliberately. This path submits UNSIGNED bytes, so
   * the compute limit is sized upstream, one network leg closer to the RPC
   * than this client is — and sized there for every SDK version, not only
   * this one. The legs that sign before anything else sees them (SPL-paid,
   * self-pay) have no such option and size themselves.
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
    // Slot our read RPC was at when the current attempt's blockhash was
    // fetched — the state the sponsor's simulation node has not caught up
    // to yet when a retryable lag error occurs.
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

        // Option B: compress against the caller's lookup table before the
        // fee-payer request. Alchemy simulates versioned txs and resolves the
        // ALT; its propagation lag is absorbed by the fee-payer retry.
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

        // 3b. Option B multi-signer: each extra required signer (e.g. the
        //     provider co-signing a subscription complete) partial-signs the
        //     already-signed tx. Signatures are independent — Alchemy's
        //     fee-payer sig and Privy's user sig are preserved; each signer
        //     fills only its own slot. Decode → sign → merge → re-encode.
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
        const { serializedTransaction: sponsoredBase64 } =
          await this.requestFeePayer(chainId, serializedTransaction);

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
