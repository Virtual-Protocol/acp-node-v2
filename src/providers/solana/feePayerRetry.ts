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
//
// One edge is GUARDED rather than blindly retryable:
//   - submit -> complete:     submit tx not yet visible -> WrongStatus (6015 / 0x177f)
// WrongStatus is ambiguous: it is also the genuine error when a job is already
// terminal (e.g. a duplicate evaluation event completing the same job twice).
// Guarded errors are retried only when the caller-supplied `retryGuard`
// confirms our own read RPC sees the state the transaction needs — i.e. the
// sponsor's node is the stale one. One unconditional grace retry is granted
// first so our own node also gets a moment to catch up before the guard's
// verdict is trusted.

import { SolanaTransactionError } from "./txConfirmation.js";

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
  "minimum context slot",
  "-32016", // JSON-RPC code for minimum-context-slot-not-reached
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
  // An expired transaction is provably dropped (blockhash validity ended
  // without inclusion), so retrying cannot double-apply. Whether a retry can
  // SUCCEED depends on the caller: attempts that rebuild with a fresh
  // blockhash recover; fixed-bytes senders cannot and must opt out via
  // FeePayerRetryOptions.retryExpired = false. The "timeout" phase (stalled
  // RPC, outcome unknown) is deliberately NOT retryable.
  if (err instanceof SolanaTransactionError && err.phase === "expired") {
    return true;
  }
  const text = collectErrorText(err);
  return RETRYABLE_FEE_PAYER_PATTERNS.some((pattern) => text.includes(pattern));
}

// Errors that are retryable ONLY when the caller's retryGuard confirms the
// failure is sponsor-node lag. Anchor always logs the error name, so match on
// it rather than the numeric code (6015 / 0x177f), which collides with other
// programs' error spaces (e.g. multi-hook-router AccountSliceOutOfBounds).
const GUARDED_FEE_PAYER_PATTERNS = ["wrongstatus", "wrong job status"];

export function isGuardedFeePayerError(err: unknown): boolean {
  const text = collectErrorText(err);
  return GUARDED_FEE_PAYER_PATTERNS.some((pattern) => text.includes(pattern));
}

export interface FeePayerRetryOptions {
  maxAttempts?: number;
  /** First-retry delay; doubles per attempt up to maxDelayMs. Default 400. */
  baseDelayMs?: number;
  /** Ceiling for the per-attempt delay (pre-jitter). Default 5000. */
  maxDelayMs?: number;
  onRetry?: (
    attempt: number,
    maxAttempts: number,
    message: string,
    error?: unknown,
  ) => void;
  /**
   * Consulted for guarded errors (see GUARDED_FEE_PAYER_PATTERNS). Return
   * true when our own read RPC confirms the transaction's state precondition
   * is met — i.e. the sponsor simulated against a stale node and the error is
   * safe to retry. Return false when our node agrees the transaction cannot
   * succeed, so the error is genuine and should propagate. A guard that
   * throws is treated as inconclusive (retry) so a transient RPC hiccup
   * cannot abort an otherwise recoverable send.
   */
  retryGuard?: (error: unknown) => Promise<boolean> | boolean;
  /**
   * Set false when every attempt rebroadcasts the SAME transaction bytes
   * (fixed blockhash): an "expired" confirmation is then terminal — the
   * blockhash's validity window has provably closed, so no retry can land it.
   * Default true, which is only correct for attempts that rebuild the
   * transaction with a fresh blockhash (the instruction-based sponsored path).
   */
  retryExpired?: boolean;
}

/**
 * Per-attempt delay: capped exponential with +/-25% jitter. The sponsor node
 * typically catches up within 1-2 slots (~400-800ms), so the first retry
 * fires fast; the cap keeps later waits bounded and the jitter de-correlates
 * concurrent senders retrying against the same lagging node.
 * `random` is injectable for tests (0 -> -25%, 0.5 -> exact, 1 -> +25%).
 */
export function computeRetryDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: number = Math.random(),
): number {
  const capped = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  const jitter = capped * 0.25 * (random * 2 - 1);
  return Math.round(capped + jitter);
}

/**
 * Runs `fn`, retrying with capped exponential backoff plus jitter (see
 * computeRetryDelayMs) when it throws an error matching a retryable
 * sponsor-simulation / broadcast-lag pattern. Guarded errors (WrongStatus)
 * are granted one unconditional grace retry, then retried only while
 * `retryGuard` confirms sponsor lag; without a retryGuard they propagate
 * immediately. Non-retryable errors and the final attempt's error propagate
 * unchanged.
 */
export async function withFeePayerRetry<T>(
  fn: () => Promise<T>,
  options: FeePayerRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 8;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 5000;

  let lastError: unknown;
  let guardedFailures = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      let retryable = isRetryableFeePayerError(err);
      if (
        retryable &&
        options.retryExpired === false &&
        err instanceof SolanaTransactionError &&
        err.phase === "expired"
      ) {
        retryable = false;
      }
      if (!retryable && options.retryGuard && isGuardedFeePayerError(err)) {
        guardedFailures++;
        if (guardedFailures === 1) {
          // Grace retry: our own read RPC may be as stale as the sponsor's
          // for a moment after a socket event; give it one backoff period
          // before trusting the guard's comparison against it.
          retryable = true;
        } else {
          try {
            retryable = await options.retryGuard(err);
          } catch {
            retryable = true; // inconclusive — do not abort on a guard hiccup
          }
        }
      }
      if (!retryable || attempt === maxAttempts) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      options.onRetry?.(attempt, maxAttempts, message, err);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          computeRetryDelayMs(attempt, baseDelayMs, maxDelayMs),
        ),
      );
    }
  }
  throw lastError;
}
