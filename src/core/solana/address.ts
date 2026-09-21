/**
 * Boundary validation for Solana addresses. `as Address` is a compile-time
 * cast, so these turn a malformed string into a named failure at the point it
 * enters Solana code rather than an encoder error deep in `@solana/kit`.
 *
 * `isAddress` also requires 32-44 characters decoding to exactly 32 bytes,
 * which is what separates a pubkey from an EVM-shaped value.
 *
 * Use only on values from outside this process. Hardcoded program IDs, derived
 * PDAs, and values decoded off an account are addresses by construction.
 */
import { isAddress, type Address } from "@solana/kit";

/**
 * Narrow a string to a Solana `Address`, throwing a message that names the
 * field and shows the offending value.
 */
export function assertSolanaAddress(value: string, label: string): Address {
  if (!isAddress(value)) {
    throw new Error(
      `Invalid Solana address for ${label}: ${JSON.stringify(value)}. ` +
        "Expected a base58 pubkey of 32-44 characters decoding to 32 bytes " +
        "(an EVM 0x-prefixed address is not one)."
    );
  }
  return value;
}

/** `assertSolanaAddress` for optional fields: passes `null`/`undefined` through. */
export function assertOptionalSolanaAddress(
  value: string | null | undefined,
  label: string
): Address | null {
  if (value == null) return null;
  return assertSolanaAddress(value, label);
}
