/**
 * Boundary validation for Solana addresses.
 *
 * `as Address` is a compile-time cast with no runtime check, so a malformed
 * string survives until something deep inside `@solana/kit` tries to base58
 * decode it — by which point the error names an encoder, not the field the
 * caller got wrong. These helpers turn that into a named failure at the point
 * the string enters Solana code.
 *
 * `isAddress` is stricter than "is base58": it also requires 32-44 characters
 * that decode to exactly 32 bytes. That length check is what separates a
 * pubkey from an EVM-shaped value, because base58 alone does not — a decimal
 * EVM job id like "610" is valid base58 and would pass an alphabet-only test.
 *
 * Use these only on values from outside this process: backend responses and
 * caller-supplied parameters. Hardcoded program IDs, PDAs returned by
 * `getProgramDerivedAddress`, and values decoded off an account are already
 * 32-byte addresses by construction and do not need re-checking.
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
