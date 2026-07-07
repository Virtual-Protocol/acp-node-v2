/**
 * JSON.stringify that tolerates BigInt values. @solana/kit parses all JSON
 * numbers in RPC responses as BigInt, so values like TransactionError from
 * getSignatureStatuses throw TypeError under plain JSON.stringify.
 */
export function stringifyBigIntSafe(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}
