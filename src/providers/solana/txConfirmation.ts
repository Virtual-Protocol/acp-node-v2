/**
 * Shared post-broadcast confirmation logic for Solana provider adapters.
 *
 * Confirmation is bounded by the transaction blockhash's lastValidBlockHeight
 * rather than a fixed wall-clock poll: once the chain's block height passes
 * it, the transaction can never be included, so "expired" is a definitive
 * dropped-transaction verdict instead of an ambiguous timeout. A wall-clock
 * safety cap remains only as a backstop against a stalled or lying RPC — that
 * is the sole path on which the outcome is genuinely unknown.
 *
 * All failures throw SolanaTransactionError carrying the signature, so
 * callers can link an explorer or re-poll the exact transaction instead of
 * parsing it out of the message string.
 */

export type ConfirmationPhase =
  /** The transaction landed on-chain but the program errored. */
  | "failed"
  /** Block height passed lastValidBlockHeight without inclusion — the
   * transaction is provably dropped and will never land. Safe to retry. */
  | "expired"
  /** Safety cap hit before the blockhash expired (stalled RPC). Outcome
   * unknown — check on-chain state before retrying. */
  | "timeout";

export class SolanaTransactionError extends Error {
  readonly signature: string;
  readonly phase: ConfirmationPhase;
  /** The raw on-chain `status.err` for the "failed" phase (e.g.
   * `{ InstructionError: [6, { Custom: 6000 }] }`), so callers can inspect
   * the failure structurally instead of parsing the message. Undefined for
   * "expired" and "timeout". */
  readonly txErr?: unknown;

  constructor(
    phase: ConfirmationPhase,
    signature: string,
    message: string,
    txErr?: unknown,
  ) {
    super(message);
    this.name = "SolanaTransactionError";
    this.phase = phase;
    this.signature = signature;
    this.txErr = txErr;
  }
}

/** Minimal structural slice of the @solana/kit RPC the confirmation loop
 * needs — lets tests pass a fake and adapters pass their real Rpc. */
export type ConfirmationRpc = {
  getSignatureStatuses(signatures: readonly string[]): {
    send(): Promise<{
      value: readonly ({
        slot: bigint;
        err: unknown;
        confirmationStatus: string | null;
      } | null)[];
    }>;
  };
  getBlockHeight(config: { commitment: "confirmed" }): {
    send(): Promise<bigint>;
  };
};

export type ConfirmTransactionOptions = {
  /** Delay between polls. Default 500ms. */
  pollIntervalMs?: number;
  /** Backstop iteration cap for a stalled RPC. Default 240 (~2 minutes at
   * the default interval — well past any blockhash validity window). */
  maxPolls?: number;
  /** Error stringifier for on-chain failures (program errors contain
   * bigints). Default String(). */
  stringifyErr?: (err: unknown) => string;
};

/**
 * Polls until the transaction is confirmed, provably dropped, or the safety
 * cap is hit. Resolves with the confirmation slot; throws
 * SolanaTransactionError otherwise.
 */
export async function confirmTransaction(
  rpc: ConfirmationRpc,
  signature: string,
  lastValidBlockHeight: bigint,
  options?: ConfirmTransactionOptions,
): Promise<{ slot: bigint }> {
  const pollIntervalMs = options?.pollIntervalMs ?? 500;
  const maxPolls = options?.maxPolls ?? 240;
  const stringifyErr = options?.stringifyErr ?? String;

  const checkStatus = async (): Promise<{ slot: bigint } | null> => {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (!status) return null;
    if (status.err) {
      throw new SolanaTransactionError(
        "failed",
        signature,
        `Transaction failed: ${stringifyErr(status.err)} (signature: ${signature})`,
        status.err,
      );
    }
    if (
      status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized"
    ) {
      return { slot: status.slot };
    }
    return null;
  };

  for (let i = 0; i < maxPolls; i++) {
    const confirmed = await checkStatus();
    if (confirmed) return confirmed;

    const blockHeight = await rpc
      .getBlockHeight({ commitment: "confirmed" })
      .send();
    if (blockHeight > lastValidBlockHeight) {
      // The height check and the status check race: the transaction may have
      // landed in the final valid block after our last status read. Re-check
      // once before declaring it dropped.
      const lastChance = await checkStatus();
      if (lastChance) return lastChance;
      throw new SolanaTransactionError(
        "expired",
        signature,
        `Transaction expired: blockhash validity ended at height ${lastValidBlockHeight} ` +
          `(chain is at ${blockHeight}) without inclusion (signature: ${signature})`,
      );
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new SolanaTransactionError(
    "timeout",
    signature,
    `Transaction confirmation timed out after ${maxPolls} polls with the ` +
      `blockhash still valid — RPC may be stalled; outcome unknown ` +
      `(signature: ${signature})`,
  );
}
