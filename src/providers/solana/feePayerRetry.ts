// Retry support for sponsored ACP transactions.
//
// The sponsor simulates on its own node and the broadcast node can lag the
// SDK's read RPC, so a transaction referencing state we confirmed moments
// earlier fails transiently. Such errors are safe to retry within blockhash
// validity (~60s) with a fresh blockhash per attempt.
//
// WrongStatus is GUARDED rather than blindly retryable: it is also the genuine
// error on an already-terminal job, so it is retried only while the caller's
// `retryGuard` confirms our own RPC sees the required state.

import { SolanaTransactionError } from "./txConfirmation.js";

const RETRYABLE_FEE_PAYER_PATTERNS = [
  "accountnotinitialized",
  "0xbc4", // Anchor 3012 AccountNotInitialized as a custom program error
  "3012",
  // Matched by NAME only: the numeric code collides with the hooks'
  // IncompleteHookAccountSet, which must fail fast.
  "budgetmismatch",
  "blockhash not found",
  "no record of a prior credit", // fee-payer credit not yet visible to broadcast node
  "could not find account",
  "account not found",
  "minimum context slot",
  "-32016", // JSON-RPC code for minimum-context-slot-not-reached
  "lookup table not found",
  "lookup table index out of bounds",
  "lookup table owner should be",
  // Kora paths. Add only strings actually observed; a speculative match would
  // retry a genuinely failed transaction, and payment/policy rejections are
  // terminal. Below: balance read and simulation land on different slots.
  // Matched on the stable prefix — the "(N apart)" suffix varies.
  "could not read the agent balance and the simulation at the same slot",
];

// A transaction that ran out of compute units, in every shape the failure
// surfaces. Matched on the flattened error chain so preflight, broadcast and
// confirmed failures all register.
const COMPUTE_BUDGET_EXCEEDED_PATTERNS = [
  "computebudgetexceeded",
  "computationalbudgetexceeded",
  "exceeded cus meter",
];

// Deterministic failures that must fail FAST even when a simulation log also
// carries retryable-looking lines. A numeric code alone never makes an error
// retryable, because IncompleteHookAccountSet collides with BudgetMismatch.
const NON_RETRYABLE_FEE_PAYER_PATTERNS = [
  "incompletehookaccountset",
  // Deterministic for a given instruction set and limit. On the sponsored
  // path the recovery is a new prepare with forceMaxCuLimit, not a resend.
  ...COMPUTE_BUDGET_EXCEEDED_PATTERNS,
];

/**
 * True when the error is a compute-budget exhaustion, whichever phase raised
 * it. Drives the sponsored path's one forceMaxCuLimit re-prepare.
 */
export function isComputeBudgetExceededError(err: unknown): boolean {
  const text = collectErrorText(err);
  return COMPUTE_BUDGET_EXCEEDED_PATTERNS.some((pattern) =>
    text.includes(pattern),
  );
}

/**
 * Flattens an error and its `cause` chain into one lowercased string; broadcast
 * failures carry their real reason in `.cause.message`.
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

// A sponsor refusal that names no reason — no program id, code, or logs — so
// nothing downstream can tell node lag from a deterministic revert. The
// detail-marker test keeps this narrow: a refusal WITH a reason is not opaque.
const OPAQUE_SIMULATION_REFUSAL_PATTERNS = [
  "transaction fails simulation",
  "transaction failed simulation",
];

const SIMULATION_DETAIL_MARKERS = [
  "program log:",
  "error code:",
  "custom program error",
  "instructionerror",
  "error processing instruction",
];

/**
 * True when a sponsor refused the transaction at simulation WITHOUT saying why,
 * so a caller can decide whether re-simulating for logs is worth a round trip.
 */
export function isOpaqueSimulationRefusal(err: unknown): boolean {
  const text = collectErrorText(err);
  return (
    OPAQUE_SIMULATION_REFUSAL_PATTERNS.some((p) => text.includes(p)) &&
    !SIMULATION_DETAIL_MARKERS.some((p) => text.includes(p))
  );
}

/**
 * The sponsor proxy's own `retryable` verdict, duck-typed so this module never
 * imports the Kora client. Authoritative where present: its client messages are
 * shared across unrelated causes, so only this flag separates them.
 */
function sponsorRetryVerdict(err: unknown): boolean | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const v = (err as { sponsorRetryable?: unknown }).sponsorRetryable;
  return typeof v === "boolean" ? v : undefined;
}

export function isRetryableFeePayerError(err: unknown): boolean {
  // An expired transaction is provably dropped, so a retry cannot double-apply.
  // Fixed-bytes senders opt out via retryExpired = false. The "timeout" phase
  // (outcome unknown) is deliberately NOT retryable.
  if (err instanceof SolanaTransactionError && err.phase === "expired") {
    return true;
  }
  // Checked BEFORE the sponsor's verdict: the guard answers whether a retry is
  // SAFE, which outranks whether it could succeed.
  if (isGuardedFeePayerError(err)) return false;
  // Structured beats textual wherever the proxy answered.
  const verdict = sponsorRetryVerdict(err);
  if (verdict !== undefined) return verdict;
  const text = collectErrorText(err);
  // Checked before the retryable list so an incidental match elsewhere in the
  // log cannot sweep a deterministic failure into a retry loop.
  if (NON_RETRYABLE_FEE_PAYER_PATTERNS.some((pattern) => text.includes(pattern))) {
    return false;
  }
  return RETRYABLE_FEE_PAYER_PATTERNS.some((pattern) => text.includes(pattern));
}

// Retryable ONLY when the caller's retryGuard confirms sponsor-node lag.
// Matched on the error NAME; the numeric code collides across programs.
const GUARDED_FEE_PAYER_PATTERNS = [
  "wrongstatus",
  "wrong job status",
  "error code: unauthorized.",
];

// Compound patterns: every substring in a group must appear. Used where a
// single marker is too broad — InvalidJob and JobNotExpired are each genuine
// errors on their own, and only the instruction context makes node lag the
// likelier reading, which the retryGuard then confirms on our own RPC.
const GUARDED_FEE_PAYER_PATTERN_GROUPS: string[][] = [
  ["instruction: batchconfigurehooks", "error code: invalidjob."],
  ["instruction: cleanupproposedterms", "error code: jobnotexpired."],
];

/**
 * True when the error is one the caller declared it EXPECTS (negative test).
 * Outranks every other classification: a revert the caller asked for is
 * deterministic, so a retry can only burn the attempt budget.
 *
 * Matched case-insensitively against the flattened error chain, so an Anchor
 * error name, a decimal code, or a hex code all work.
 */
export function isExpectedFeePayerError(
  err: unknown,
  expectedErrors: string[] | undefined,
): boolean {
  if (!expectedErrors || expectedErrors.length === 0) return false;
  const text = collectErrorText(err);
  return expectedErrors.some((name) => {
    const needle = name.trim().toLowerCase();
    return needle.length > 0 && text.includes(needle);
  });
}

export function isGuardedFeePayerError(err: unknown): boolean {
  const text = collectErrorText(err);
  return (
    GUARDED_FEE_PAYER_PATTERNS.some((pattern) => text.includes(pattern)) ||
    GUARDED_FEE_PAYER_PATTERN_GROUPS.some((group) =>
      group.every((pattern) => text.includes(pattern)),
    )
  );
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
   * Consulted for guarded errors. Return true when our own read RPC confirms
   * the transaction's state precondition is met, false when it agrees the
   * transaction cannot succeed. A guard that throws counts as inconclusive
   * (retry).
   */
  retryGuard?: (error: unknown) => Promise<boolean> | boolean;
  /**
   * Error names/codes the CALLER expects this send to fail with. A match
   * propagates on the first attempt, ahead of the retryable and guarded lists.
   */
  expectedErrors?: string[];
  /**
   * Set false when every attempt rebroadcasts the SAME transaction bytes, where
   * an "expired" confirmation is terminal. Default true, correct only for
   * attempts that rebuild with a fresh blockhash.
   */
  retryExpired?: boolean;
}

/**
 * Per-attempt delay: capped exponential with +/-25% jitter, which de-correlates
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
 * Runs `fn`, retrying with capped exponential backoff plus jitter on retryable
 * sponsor-simulation / broadcast-lag errors. Guarded errors get one grace
 * retry, then are retried only while `retryGuard` confirms lag; without a
 * retryGuard they propagate immediately. `expectedErrors` propagate on attempt
 * one. Everything else propagates unchanged.
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
      // Terminal on attempt 1, ahead of every other rule.
      if (isExpectedFeePayerError(err, options.expectedErrors)) throw err;
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
          // Grace retry: our own read RPC may itself be stale for a moment
          // after a socket event.
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
