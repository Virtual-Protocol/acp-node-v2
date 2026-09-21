/**
 * Shared [u8; 32] field encoders for the Solana clients. The deliverable and
 * the completion/rejection reason occupy fixed 32-byte on-chain slots, encoded
 * to mirror the EVM client so both chains stay byte-compatible.
 *
 * Every Solana path writing either slot must go through this module.
 */
import {
  fixEncoderSize,
  getBytesEncoder,
} from "@solana/kit";
import { hexToBytes, keccak256, toHex, type Hex } from "viem";

/**
 * Encode a completion/rejection reason into the on-chain [u8; 32] slot,
 * mirroring the EVM client's `toBytes32`:
 *   - an already-32-byte hex value passes through unchanged;
 *   - UTF-8 that fits in 32 bytes is stored right-zero-padded, so short
 *     reasons stay readable on-chain;
 *   - anything longer is stored as its keccak256 commitment.
 * The reason has no off-chain copy, unlike the deliverable.
 */
export function encodeReasonBytes(reason: string): Uint8Array {
  if (reason.startsWith("0x") && reason.length === 66) {
    return hexToBytes(reason as Hex);
  }
  const utf8 = new TextEncoder().encode(reason);
  if (utf8.length <= 32) {
    return fixEncoderSize(getBytesEncoder(), 32).encode(utf8) as Uint8Array;
  }
  return hexToBytes(keccak256(toHex(reason)));
}

/**
 * Encode a deliverable into the on-chain [u8; 32] slot as a keccak256
 * commitment of the full text, matching the EVM client
 * (`keccak256(toHex(deliverable))` -> bytes32) and the backend, which reads
 * this field as `deliverableHash`. The full deliverable is persisted off-chain
 * via `postDeliverable`; the chain never holds readable deliverable text.
 * UTF-8 truncation into 32 bytes silently drops anything past 32 bytes and
 * makes distinct deliverables collide — never store the raw text.
 */
export function encodeDeliverableBytes(deliverable: string): Uint8Array {
  return hexToBytes(keccak256(toHex(deliverable)));
}
