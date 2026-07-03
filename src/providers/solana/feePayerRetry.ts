// Retry support for alchemy_requestFeePayer.
//
// Alchemy's fee-payer service simulates the transaction on its own node,
// which can lag the SDK's RPC by a few slots (common on devnet). When a
// transaction references an account created moments earlier (e.g. setBudget
// right after createJob), the sponsor-side simulation fails with Anchor
// error 3012 (AccountNotInitialized) even though the account is confirmed
// on the SDK's node. These failures are transient and safe to retry within
// blockhash validity (~60s).

const RETRYABLE_FEE_PAYER_PATTERNS = [
  "AccountNotInitialized",
  "0xbc4", // Anchor 3012 AccountNotInitialized as a custom program error
  "Blockhash not found",
];

export function isRetryableFeePayerError(message: string): boolean {
  return RETRYABLE_FEE_PAYER_PATTERNS.some((pattern) =>
    message.includes(pattern),
  );
}

export interface FeePayerRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, maxAttempts: number, message: string) => void;
}

/**
 * Runs `fn`, retrying with linear backoff (baseDelayMs * attempt) when it
 * throws an error matching a retryable sponsor-simulation pattern.
 * Non-retryable errors and the final attempt's error propagate unchanged.
 */
export async function withFeePayerRetry<T>(
  fn: () => Promise<T>,
  options: FeePayerRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1500;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!isRetryableFeePayerError(message) || attempt === maxAttempts) {
        throw err;
      }
      options.onRetry?.(attempt, maxAttempts, message);
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * attempt),
      );
    }
  }
  throw lastError;
}
