/**
 * Solana multi-hook-router + subscription-hook support: PDA derivations and
 * opt-params encoders in @solana/kit style.
 *
 * These are the building blocks the router CPI fan-out needs. The router routes
 * a job's lifecycle action (setBudget/fund/submit/complete/reject) to a
 * per-selector list of sub-hooks (fund-transfer-hook, subscription-hook); each
 * sub-hook's accounts are appended to the instruction's remainingAccounts in a
 * fixed order, prefixed by a multi-hook header that tells the router how many
 * accounts and what opt-params belong to each sub-hook.
 */
import {
  getProgramDerivedAddress,
  getAddressDecoder,
  getAddressEncoder,
  getUtf8Encoder,
  getU8Encoder,
  getU32Encoder,
  getU64Encoder,
  getI64Encoder,
  getU64Decoder,
  getI64Decoder,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";

const utf8 = getUtf8Encoder();
const addr = getAddressEncoder();
const u64le = (v: bigint | number): ReadonlyUint8Array => getU64Encoder().encode(BigInt(v));

async function pda(programAddress: Address, seeds: ReadonlyUint8Array[]): Promise<Address> {
  const [p] = await getProgramDerivedAddress({ programAddress, seeds });
  return p;
}

// ---------------------------------------------------------------------------
// PDA derivations (program id is passed in per call)
// ---------------------------------------------------------------------------

export const acpStatePda = (acp: Address) => pda(acp, [utf8.encode("acp_state")]);
export const jobPda = (acp: Address, client: Address, jobId: bigint) =>
  pda(acp, [utf8.encode("job"), addr.encode(client), u64le(jobId)]);
export const hookWhitelistPda = (acp: Address, hook: Address) =>
  pda(acp, [utf8.encode("hook_whitelist"), addr.encode(hook)]);
export const vaultAuthorityPda = (acp: Address, job: Address) =>
  pda(acp, [utf8.encode("vault_authority"), addr.encode(job)]);

export const hookStatePda = (hook: Address) => pda(hook, [utf8.encode("hook_state")]);
export const hookMetadataPda = (hook: Address) => pda(hook, [utf8.encode("hook_metadata")]);

export const routerStatePda = (router: Address) => pda(router, [utf8.encode("router_state")]);
export const hookRouterPda = (router: Address, jobId: bigint) =>
  pda(router, [utf8.encode("hook_router"), u64le(jobId)]);

export const proposedTermsPda = (subHook: Address, jobId: bigint) =>
  pda(subHook, [utf8.encode("proposed_terms"), u64le(jobId)]);

export const subExpiryPda = (subState: Address, client: Address, provider: Address, pkg: bigint) =>
  pda(subState, [
    utf8.encode("sub_expiry"),
    addr.encode(client),
    addr.encode(provider),
    u64le(pkg),
  ]);
export const writerRegistryPda = (subState: Address, writer: Address) =>
  pda(subState, [utf8.encode("writer"), addr.encode(writer)]);
export const stateConfigPda = (subState: Address) => pda(subState, [utf8.encode("state_config")]);

export const intentPda = (fundHook: Address, jobId: bigint, kind: 0 | 1) =>
  pda(fundHook, [utf8.encode("intent"), u64le(jobId), new Uint8Array([kind])]);
export const fundRequestIntentIdPda = (fundHook: Address, jobId: bigint) =>
  pda(fundHook, [utf8.encode("fund_request_intent_id"), u64le(jobId)]);
export const providerEscrowIntentIdPda = (fundHook: Address, jobId: bigint) =>
  pda(fundHook, [utf8.encode("provider_escrow_intent_id"), u64le(jobId)]);
export const escrowAuthorityPda = (fundHook: Address, jobId: bigint) =>
  pda(fundHook, [utf8.encode("escrow_authority"), u64le(jobId)]);

// ---------------------------------------------------------------------------
// Opt-params encoders (byte-for-byte compatible with what the deployed
// programs decode).
// ---------------------------------------------------------------------------

export type HookEntry = { accountCount: number; params: Uint8Array };

/**
 * Multi-hook PerHook header (mode byte 0x01):
 *   [u8 0x01][u32 entryCount]( [u32 accountCount][u32 paramsLen][params] )*
 * One entry per configured sub-hook, in fan-out order.
 */
export function encodeMultiHookHeader(entries: HookEntry[]): Uint8Array {
  const size = 1 + 4 + entries.reduce((s, e) => s + 8 + e.params.length, 0);
  const buf = new Uint8Array(size);
  let o = 0;
  buf.set(getU8Encoder().encode(0x01), o); o += 1;
  buf.set(getU32Encoder().encode(entries.length), o); o += 4;
  for (const e of entries) {
    buf.set(getU32Encoder().encode(e.accountCount), o); o += 4;
    buf.set(getU32Encoder().encode(e.params.length), o); o += 4;
    buf.set(e.params, o); o += e.params.length;
  }
  return buf;
}

/** Sub-hook opt_params (16 bytes): [i64 duration][u64 packageId]. */
export function encodeSubParams(durationSecs: bigint, packageId: bigint): Uint8Array {
  const buf = new Uint8Array(16);
  buf.set(getI64Encoder().encode(durationSecs), 0);
  buf.set(getU64Encoder().encode(packageId), 8);
  return buf;
}

/** Inverse of encodeSubParams. Returns null unless the buffer is >= 16 bytes. */
export function decodeSubParams(
  bytes: Uint8Array,
): { durationSecs: bigint; packageId: bigint } | null {
  if (bytes.length < 16) return null;
  return {
    durationSecs: getI64Decoder().decode(bytes.subarray(0, 8)),
    packageId: getU64Decoder().decode(bytes.subarray(8, 16)),
  };
}

/** Fund-hook post_fund confirmation (72 bytes): [token:32][u64 amount][recipient:32]. */
export function encodeFundConfirmation(token: Address, amount: bigint, recipient: Address): Uint8Array {
  const buf = new Uint8Array(72);
  buf.set(addr.encode(token), 0);
  buf.set(getU64Encoder().encode(amount), 32);
  buf.set(addr.encode(recipient), 40);
  return buf;
}

/** Fund-hook post_submit escrow proposal (40 bytes): [token:32][u64 amount]. */
export function encodeEscrowProposal(token: Address, amount: bigint): Uint8Array {
  const buf = new Uint8Array(40);
  buf.set(addr.encode(token), 0);
  buf.set(getU64Encoder().encode(amount), 32);
  return buf;
}

// ---------------------------------------------------------------------------
// ProposedTerms raw reader
// ---------------------------------------------------------------------------

/**
 * Anchor discriminator for the subscription hook's ProposedTerms account:
 * sha256("account:ProposedTerms")[0..8]. The account type is not exposed in
 * the hook's IDL, so no Codama fetcher exists — this module reads it raw.
 */
const PROPOSED_TERMS_DISCRIMINATOR = new Uint8Array([
  0xf3, 0xa5, 0xca, 0x36, 0x04, 0x40, 0x3d, 0x6e,
]);

// On-chain ProposedTerms layout: 8-byte discriminator,
// job_id u64 LE, provider Pubkey, duration i64 LE, package_id u64 LE, bump u8.
const PROPOSED_TERMS_SIZE = 8 + 8 + 32 + 8 + 8 + 1;

export type ProposedTerms = {
  jobId: bigint;
  provider: Address;
  /** Subscription duration in seconds (i64; the hook rejects non-positive). */
  duration: bigint;
  packageId: bigint;
};

/**
 * Read and decode the subscription hook's proposed_terms PDA for a job.
 * Returns null when the account does not exist, was closed, or does not
 * decode as ProposedTerms for this jobId (defensive: length, discriminator,
 * and job-id echo are all checked, so a layout drift in the on-chain program
 * surfaces as null rather than as garbage terms).
 */
export async function fetchProposedTerms(
  rpc: {
    getAccountInfo: (
      address: Address,
      config: { encoding: "base64"; commitment: "confirmed" | "finalized" | "processed" }
    ) => { send: () => Promise<{ value: { data: unknown } | null }> };
  },
  subHook: Address,
  jobId: bigint,
  commitment: "confirmed" | "finalized" | "processed" = "confirmed"
): Promise<ProposedTerms | null> {
  const pdaAddress = await proposedTermsPda(subHook, jobId);
  const info = await rpc
    .getAccountInfo(pdaAddress, { encoding: "base64", commitment })
    .send();
  const raw = info.value?.data;
  const b64 = Array.isArray(raw) ? raw[0] : undefined;
  if (typeof b64 !== "string" || b64.length === 0) return null;
  const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (data.length < PROPOSED_TERMS_SIZE) return null;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PROPOSED_TERMS_DISCRIMINATOR[i]) return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const storedJobId = view.getBigUint64(8, true);
  if (storedJobId !== jobId) return null;
  return {
    jobId: storedJobId,
    provider: getAddressDecoder().decode(data.subarray(16, 48)),
    duration: view.getBigInt64(48, true),
    packageId: view.getBigUint64(56, true),
  };
}
