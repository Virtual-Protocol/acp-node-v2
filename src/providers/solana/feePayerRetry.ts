// Retry support for sponsored ACP transactions.
//
// Alchemy's fee-payer service simulates the transaction on its own node, and
// the broadcast RPC node can likewise lag the SDK's read RPC by a few slots
// (common on devnet). When a transaction references state we confirmed moments
// earlier, the sponsor-side simulation or the broadcast fails transiently even
// though our node already sees it:
//   - createJob -> setBudget: job PDA not yet visible  -> AccountNotInitialized (3012 / 0xbc4)
//   - setBudget -> fund:      new budget not yet visible -> BudgetMismatch (6019 / 0x1783)
//   - fund -> submit:         vault PDA not yet visible  -> AccountNotInitialized (3012 / 0xbc4)
//   - broadcast:              sponsor fee-payer credit not yet visible
//                             -> "found no record of a prior credit"
//   - either path:            our blockhash not yet known -> Blockhash not found
// All are safe to retry within blockhash validity (~60s) with a fresh
// blockhash per attempt.

const RETRYABLE_FEE_PAYER_PATTERNS = [
  "accountnotinitialized",
  "0xbc4", // Anchor 3012 AccountNotInitialized as a custom program error
  "3012",
  "budgetmismatch",
  "0x1783", // Anchor 6019 BudgetMismatch as a custom program error
  "6019",
  "blockhash not found",
  "no record of a prior credit", // fee-payer credit not yet visible to broadcast node
  "could not find account",
  "account not found",
];

/**
 * Flattens an error and its `cause` chain into a single lowercased string.
 * Broadcast failures surface as a generic SolanaError ("Transaction
 * simulation failed") whose real reason lives in `.cause.message`, so matching
 * `error.message` alone would miss them.
 */
function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 6; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
    } else {
      parts.push(String(current));
    }
    current = (current as { cause?: unknown })?.cause;
  }
  return parts.join(" ").toLowerCase();
}

export function isRetryableFeePayerError(err: unknown): boolean {
  const text = collectErrorText(err);
  return RETRYABLE_FEE_PAYER_PATTERNS.some((pattern) => text.includes(pattern));
}

export interface FeePayerRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, maxAttempts: number, message: string) => void;
}

/**
 * Runs `fn`, retrying with linear backoff (baseDelayMs * attempt) when it
 * throws an error matching a retryable sponsor-simulation / broadcast-lag
 * pattern. Non-retryable errors and the final attempt's error propagate
 * unchanged.
 */
export async function withFeePayerRetry<T>(
  fn: () => Promise<T>,
  options: FeePayerRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 8;
  const baseDelayMs = options.baseDelayMs ?? 1500;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableFeePayerError(err) || attempt === maxAttempts) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      options.onRetry?.(attempt, maxAttempts, message);
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * attempt),
      );
    }
  }
  throw lastError;
}
