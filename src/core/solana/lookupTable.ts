/**
 * Address lookup table lifecycle for the multi-hook complete leg. The
 * complete instruction carries ~40 accounts — beyond the legacy transaction
 * size limit — so the sender creates a fresh ALT, extends it with every
 * non-signer account, waits until the table is safe to reference, and then
 * compresses a v0 transaction against it.
 *
 * The table is never deactivated or closed: rent (paid by the actor) stays
 * locked and one table is left behind per complete. Closing requires a
 * deactivate + cooldown across ~513 slots, which is not worth blocking a
 * job completion on.
 */
import {
  AccountRole,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type Address,
} from "@solana/kit";
import type {
  ISolanaProviderAdapter,
  SolanaInstructionLike,
} from "../../providers/types.js";
import { ACP_COMMITMENT } from "../constants.js";

const ALT_PROGRAM_ID = "AddressLookupTab1e1111111111111111111111111" as Address;
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111" as Address;

// LookupTableMeta serialized size; the account's address list begins here.
const LUT_META_SIZE = 56;
// `last_extended_slot` (u64 LE) offset inside LookupTableMeta.
const LUT_LAST_EXTENDED_SLOT_OFFSET = 12;
const EXTEND_CHUNK = 20;

const ae = getAddressEncoder();
const ad = getAddressDecoder();

type Rpc = ReturnType<ISolanaProviderAdapter["getRpc"]>;

/**
 * Create a fresh ALT owned by the adapter's signer and extend it with
 * `addresses`, then poll until it is safe to use for compression. Returns the
 * table address and the authoritative ON-CHAIN address ordering — always
 * compress against that ordering, not the local input array: the table
 * address derives from (authority, slot), which cannot be nonced, so a
 * concurrent same-slot complete may share this table and its extends land
 * interleaved with ours, shifting the indices.
 */
export async function createAndWarmLookupTable(
  actor: ISolanaProviderAdapter,
  chainId: number,
  addresses: Address[]
): Promise<{ lut: Address; addresses: Address[] }> {
  const rpc = actor.getRpc(chainId);
  const me = actor.getSigner().address;
  const recentSlot = await rpc.getSlot({ commitment: "finalized" }).send();
  const [lut, bump] = await getProgramDerivedAddress({
    programAddress: ALT_PROGRAM_ID,
    seeds: [ae.encode(me), getU64Encoder().encode(recentSlot)],
  });
  const accounts: SolanaInstructionLike["accounts"] = [
    { address: lut, role: AccountRole.WRITABLE },
    { address: me, role: AccountRole.READONLY_SIGNER },
    { address: me, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
  ];

  const create = new Uint8Array(13);
  const dv = new DataView(create.buffer);
  dv.setUint32(0, 0, true); // CreateLookupTable
  dv.setBigUint64(4, recentSlot, true);
  create[12] = bump;
  await actor.sendInstructions(chainId, [
    { programAddress: ALT_PROGRAM_ID, accounts, data: create },
  ]);

  for (let i = 0; i < addresses.length; i += EXTEND_CHUNK) {
    const chunk = addresses.slice(i, i + EXTEND_CHUNK);
    const ext = new Uint8Array(12 + chunk.length * 32);
    const edv = new DataView(ext.buffer);
    edv.setUint32(0, 2, true); // ExtendLookupTable
    edv.setBigUint64(4, BigInt(chunk.length), true);
    chunk.forEach((a, j) => ext.set(ae.encode(a), 12 + j * 32));
    await actor.sendInstructions(chainId, [
      { programAddress: ALT_PROGRAM_ID, accounts, data: ext },
    ]);
  }

  return { lut, addresses: await awaitLookupTableReady(rpc, lut, addresses) };
}

/**
 * Poll the ALT until it is safe to use for compression:
 *  - every one of `expected` has landed on-chain (partial-read guard: a
 *    missing address would stay uncompressed and can overflow the tx size).
 *    This is a SUBSET check, not a count check, so a table shared by a
 *    concurrent same-slot complete — whose extends make the on-chain list
 *    LONGER than `expected` — still passes; and
 *  - its `last_extended_slot` is strictly behind the current slot: the
 *    runtime rejects a lookup table referenced in the slot it was extended.
 * Returns the full on-chain ordering (superset-safe for compression).
 * Bounded retry; throws if the table never converges.
 */
export async function awaitLookupTableReady(
  rpc: Rpc,
  lut: Address,
  expected: Address[]
): Promise<Address[]> {
  const RETRIES = 30;
  const DELAY_MS = 400;
  for (let i = 0; i < RETRIES; i++) {
    const state = await fetchLookupTableState(rpc, lut);
    if (state) {
      const onChain = new Set(state.addresses as string[]);
      const allPresent = expected.every((a) => onChain.has(a as string));
      if (allPresent) {
        const slot = await rpc.getSlot({ commitment: ACP_COMMITMENT }).send();
        if (state.lastExtendedSlot < slot) return state.addresses;
      }
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  throw new Error(
    `lookup table ${lut} did not converge (all ${expected.length} addresses present + warmed up)`
  );
}

/**
 * Decode an on-chain address lookup table: its ordered address list and its
 * `last_extended_slot`. Returns null while the account is not yet visible at
 * the ACP commitment.
 */
export async function fetchLookupTableState(
  rpc: Rpc,
  lut: Address
): Promise<{ addresses: Address[]; lastExtendedSlot: bigint } | null> {
  const info = await rpc
    .getAccountInfo(lut, { encoding: "base64", commitment: ACP_COMMITMENT })
    .send();
  const b64 = info.value?.data?.[0];
  if (!b64) return null;
  const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (data.length < LUT_META_SIZE) return null;
  const lastExtendedSlot = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength
  ).getBigUint64(LUT_LAST_EXTENDED_SLOT_OFFSET, true);
  const addresses: Address[] = [];
  for (let off = LUT_META_SIZE; off + 32 <= data.length; off += 32) {
    addresses.push(ad.decode(data.subarray(off, off + 32)));
  }
  return { addresses, lastExtendedSlot };
}
