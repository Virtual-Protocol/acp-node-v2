/**
 * Shard selection for the protocol's contended settlement destinations.
 *
 * The programs run a MEMBERSHIP test: any live shard is accepted, so the rule
 * here is a convention. Never treat a mismatch as an error or require a
 * specific shard.
 *
 * One index picks the rent destination, the platform-fee wallet and the
 * paymaster's fee payer together. `tests/shardIndex.test.ts` pins the vector
 * shared with the backend proxy.
 */
import type { Address } from "@solana/kit";
import { getAddressEncoder } from "@solana/kit";

/**
 * Which shard a job maps to, in `[0, count)`. Reads a little-endian u64 from
 * the job address so the count can be any number, not just a power of two.
 *
 * `count` includes the scalar as shard 0; 0 and 1 both mean scalar-only.
 */
export function shardIndex(key: Address, count: number): number {
  if (!Number.isInteger(count) || count <= 1) return 0;
  const bytes = getAddressEncoder().encode(key);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Number(view.getBigUint64(0, true) % BigInt(count));
}

/**
 * The live shard set for one destination: the scalar at index 0, then as many
 * array slots as the count admits. Mirrors `AcpState::extra_shards` including
 * its clamp, so a zero-filled realloc tail is never read.
 */
export function liveShards(
  scalar: Address,
  shards: readonly Address[],
  count: number,
): Address[] {
  const extra = Math.min(Math.max(count | 0, 1), shards.length + 1) - 1;
  return [scalar, ...shards.slice(0, extra)];
}

/** The rent destination for `jobKey`, given the on-chain sponsor set. */
export function pickSponsor(
  jobKey: Address,
  scalar: Address,
  shards: readonly Address[],
  count: number,
): Address {
  const live = liveShards(scalar, shards, count);
  return live[shardIndex(jobKey, live.length)]!;
}

/**
 * The platform-fee OWNER WALLET for `jobKey`. Derive the token account as
 * `ATA(owner, vault_mint)`; the program checks the owner, not the address.
 */
export function pickTreasuryOwner(
  jobKey: Address,
  scalar: Address,
  shards: readonly Address[],
  count: number,
): Address {
  const live = liveShards(scalar, shards, count);
  return live[shardIndex(jobKey, live.length)]!;
}

/**
 * The shard-carrying subset of `AcpState`. Structural rather than an import of
 * the generated type, so this module stays free of the Codama client.
 */
export type ShardedState = {
  sponsor: Address;
  sponsorShards: readonly Address[];
  sponsorShardCount: number;
  platformTreasury: Address;
  treasuryShards: readonly Address[];
  treasuryShardCount: number;
};

/**
 * The rent destination a job PINNED at creation. Mirrors `AcpState::sponsor_at`
 * plus the program's fallback to the scalar for an index the set has shrunk
 * past.
 *
 * Prefer this over {@link sponsorFor} on every close path: a derived shard
 * agrees only while the count is unchanged since creation.
 */
export function sponsorForRecorded(state: ShardedState, shardIndex: number): Address {
  const live = liveShards(state.sponsor, state.sponsorShards, state.sponsorShardCount);
  return live[shardIndex] ?? state.sponsor;
}

/**
 * Rent destination DERIVED from the job address.
 *
 * @deprecated for close paths — use {@link sponsorForRecorded} with the job's
 * own `shardIndex`. Still correct at CREATION time, where no job exists yet and
 * the derivation is what chooses the shard in the first place.
 */
export function sponsorFor(state: ShardedState, jobKey: Address): Address {
  return pickSponsor(
    jobKey,
    state.sponsor,
    state.sponsorShards,
    state.sponsorShardCount,
  );
}

/** Platform-fee owner wallet for this job. Derive its ATA against the vault mint. */
export function treasuryOwnerFor(state: ShardedState, jobKey: Address): Address {
  return pickTreasuryOwner(
    jobKey,
    state.platformTreasury,
    state.treasuryShards,
    state.treasuryShardCount,
  );
}

/**
 * The fee payer to PIN for a sponsored send, or `undefined` when the sponsor
 * set is scalar-only.
 *
 * Pinning the job's rent shard is meaningful only where the signer pool is
 * aligned to the sponsor set; at one shard every index resolves to the scalar,
 * so gating on a live fan-out costs no behaviour.
 */
export function pinIfSharded(
  state: ShardedState,
  resolved: Address,
): Address | undefined {
  return state.sponsorShardCount > 1 ? resolved : undefined;
}

/**
 * Every live rent destination. The address-lookup-table builder must carry the
 * whole set: an uncovered shard costs 31 bytes of transaction size.
 */
export function allSponsors(state: ShardedState): Address[] {
  return liveShards(state.sponsor, state.sponsorShards, state.sponsorShardCount);
}

/** Every live platform-fee owner wallet. Same reason as `allSponsors`. */
export function allTreasuryOwners(state: ShardedState): Address[] {
  return liveShards(
    state.platformTreasury,
    state.treasuryShards,
    state.treasuryShardCount,
  );
}
