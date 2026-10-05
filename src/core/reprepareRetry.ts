/**
 * Retry wrapper for prepare-then-send flows where the prepared transaction can
 * go stale between prepare and inclusion. Each attempt rebuilds from fresh
 * chain state via `prepare`.
 *
 * `isStalePrepareError` decides whether a failure is worth a rebuild; anything
 * else propagates unchanged, as does the final attempt's error.
 *
 * `delayMs` waits before each re-prepare (default 0). Use it when the
 * staleness is node lag rather than a lost race.
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
