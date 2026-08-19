/**
 * Retry wrapper for prepare-then-send flows where the prepared transaction
 * can go stale between prepare and inclusion (e.g. Solana hook intent PDAs
 * or the job PDA, both derived from a counter that another transaction may
 * advance first). Each attempt rebuilds the transaction from fresh chain
 * state via `prepare`.
 *
 * `isStalePrepareError` decides whether a send failure is worth a rebuild;
 * anything else propagates unchanged, as does the final attempt's error.
 *
 * `delayMs` waits before each re-prepare (default 0, preserving the original
 * immediate-retry behavior). Use it when the staleness is node lag rather
 * than a lost race: an immediate re-read can return the same stale state,
 * while the lagging node typically catches up within 1-2 slots (~400-800ms).
 */
export async function withReprepare<TPrepared, TResult>(
  prepare: () => Promise<TPrepared>,
  send: (prepared: TPrepared) => Promise<TResult>,
  isStalePrepareError: (err: unknown) => Promise<boolean> | boolean,
  maxAttempts = 3,
  delayMs = 0,
): Promise<TResult> {
  for (let attempt = 1; ; attempt++) {
    const prepared = await prepare();
    try {
      return await send(prepared);
    } catch (err) {
      if (attempt >= maxAttempts || !(await isStalePrepareError(err))) {
        throw err;
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
