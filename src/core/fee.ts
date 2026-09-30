import type { AcpAgentOffering } from "../events/types.js";

/**
 * Unit of an offering's percentage `priceValue`: basis points or percent.
 *
 * Which one a `percentage` offering uses is a registry convention and must be
 * confirmed before relying on it. {@link computePercentageFee} takes the unit
 * explicitly rather than assuming one.
 */
export type FeeUnit = "bps" | "percent";

// `priceValue` is a JS number and may be fractional (e.g. 8.5 bps). We scale it
// to an integer at this fixed precision so the fee math stays in bigint for the
// (large) notional. Six decimals of rate precision is ample for bps / percent.
const RATE_PRECISION = 1_000_000n;

/**
 * Compute a proportional fee from a notional amount.
 *
 * The fee is returned in the same atomic units / token as `notionalAtomic`.
 * When the notional token differs from the fee (budget) token, the caller must
 * USD-normalize first; the SDK does not know cross-token rates.
 *
 * Rounds DOWN (integer division). `priceValue` may be fractional.
 *
 * @param notionalAtomic Fee notional in atomic units (e.g. 1000 USDC ->
 *   1_000_000_000n at 6 decimals).
 * @param priceValue The offering's `priceValue` (the rate).
 * @param unit Whether `priceValue` is basis points or percent. See {@link FeeUnit}.
 */
export function computePercentageFee(
  notionalAtomic: bigint,
  priceValue: number,
  unit: FeeUnit
): bigint {
  if (notionalAtomic < 0n) {
    throw new Error(
      `notionalAtomic must be non-negative, got ${notionalAtomic}`
    );
  }
  if (!Number.isFinite(priceValue) || priceValue < 0) {
    throw new Error(
      `priceValue must be a non-negative finite number, got ${priceValue}`
    );
  }
  const scaledRate = BigInt(Math.round(priceValue * Number(RATE_PRECISION)));
  const denom = (unit === "bps" ? 10_000n : 100n) * RATE_PRECISION;
  return (notionalAtomic * scaledRate) / denom;
}

/**
 * Read the fee notional (atomic, as bigint) from a requirement payload, using
 * the field named by `offering.feeBasisField`. Throws if the offering declares
 * no fee-basis field, or the requirement value is missing / not an integer
 * atomic amount.
 */
export function readFeeBasis(
  offering: AcpAgentOffering,
  requirementData: Record<string, unknown>
): bigint {
  const field = offering.feeBasisField;
  if (!field) {
    throw new Error(
      `Offering "${offering.name}" does not declare feeBasisField; cannot derive a proportional fee`
    );
  }
  const raw = requirementData[field];
  if (raw === undefined || raw === null) {
    throw new Error(`Requirement is missing fee-basis field "${field}"`);
  }
  return toBigIntAtomic(raw, field);
}

function toBigIntAtomic(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    // A JS number cannot represent an integer above 2^53 exactly, so a large
    // atomic amount is silently rounded before it ever reaches BigInt (and
    // Number.isInteger still returns true for the rounded double). Reject
    // unsafe values and require large notionals as a decimal string, which the
    // branch below converts losslessly.
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Fee-basis field "${field}" must be a safe-integer atomic amount ` +
          `(<= ${Number.MAX_SAFE_INTEGER}); pass larger amounts as a decimal ` +
          `string, got ${value}`
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new Error(
    `Fee-basis field "${field}" is not a valid atomic amount: ${String(value)}`
  );
}

/**
 * Assert that the notional the buyer DECLARED in the requirement matches the
 * notional BOUND in their signed intent (Permit2 / ERC-3009). A provider should
 * call this before `setBudget` so an under- or over-declared notional is
 * rejected before any payment.
 *
 * Extracting `bound` from the signed intent is intent-standard-specific
 * (Permit2 / ERC-3009) and lives outside this SDK; this helper only compares.
 * It is only as trustworthy as `bound`: pass a value recovered from the
 * verified signature, not one the buyer supplied in the clear. Both amounts
 * must use the same atomic scale (same token and decimals). The comparison is
 * exact.
 */
export function assertNotionalMatches(declared: bigint, bound: bigint): void {
  if (declared !== bound) {
    throw new Error(
      `Declared notional ${declared} does not match the notional bound in the signed intent ${bound}`
    );
  }
}
