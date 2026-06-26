/**
 * Solana multi-hook-router + subscription-hook support: PDA derivations and
 * opt-params encoders, ported from sol-acp-contracts (scripts/lib/router-core.ts
 * + tests/helpers/multi-hook.ts) into @solana/kit style.
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
  getAddressEncoder,
  getUtf8Encoder,
  getU8Encoder,
  getU32Encoder,
  getU64Encoder,
  getI64Encoder,
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
// PDA derivations (mirror router-core.ts; program id is passed in per call)
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

export const intentPda = (fundHook: Address, intentId: bigint) =>
  pda(fundHook, [utf8.encode("intent"), u64le(intentId)]);
export const fundRequestIntentIdPda = (fundHook: Address, jobId: bigint) =>
  pda(fundHook, [utf8.encode("fund_request_intent_id"), u64le(jobId)]);
export const providerEscrowIntentIdPda = (fundHook: Address, jobId: bigint) =>
  pda(fundHook, [utf8.encode("provider_escrow_intent_id"), u64le(jobId)]);
export const escrowAuthorityPda = (fundHook: Address, jobId: bigint) =>
  pda(fundHook, [utf8.encode("escrow_authority"), u64le(jobId)]);

// ---------------------------------------------------------------------------
// Opt-params encoders (byte-for-byte compatible with sol-acp-contracts'
// tests/helpers/multi-hook.ts).
// ---------------------------------------------------------------------------

export type HookEntry = { accountCount: number; params: Uint8Array };

/**
 * Multi-hook PerHook header (F-69 mode byte 0x01):
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

/** Fund-hook post_fund confirmation (72 bytes): [token:32][u64 amount][recipient:32]. */
export function encodeFundConfirmation(token: Address, amount: bigint, recipient: Address): Uint8Array {
  const buf = new Uint8Array(72);
  buf.set(addr.encode(token), 0);
  buf.set(getU64Encoder().encode(amount), 32);
  buf.set(addr.encode(recipient), 40);
  return buf;
}
