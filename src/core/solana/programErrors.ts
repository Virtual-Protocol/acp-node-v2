import type { JobStateDiagnosis } from "./jobStateRetryGuard.js";

/**
 * A sponsored send failed at simulation. The message is the node's error
 * reformatted one log per line; `cause` holds the original error. `diagnosis`
 * is set when the job-state retry guard confirmed the failure (wrong state or
 * passed expiry) against our own read RPC — those sends fail fast instead of
 * retrying.
 */
export class AcpSendError extends Error {
  /** The original error, with the unmodified simulation logs. */
  readonly cause: unknown;
  readonly diagnosis: JobStateDiagnosis | null;

  constructor(
    message: string,
    cause: unknown,
    diagnosis: JobStateDiagnosis | null = null,
  ) {
    super(message);
    this.cause = cause;
    this.diagnosis = diagnosis;
    this.name = "AcpSendError";
  }
}

/** Flattens an error and its `cause` chain into one string, case preserved. */
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
  return parts.join(" ");
}

/**
 * Extracts the node-facing error from the raw text and reformats it: the
 * headline (with the alchemy_requestFeePayer prefix when present), then one
 * simulation log per line. Null when the text has no node error to show.
 */
export function formatNodeError(err: unknown): string | null {
  const text = collectErrorText(err);
  const simulationAt = text.indexOf("Transaction simulation failed");
  if (simulationAt === -1) return null;
  const sponsorAt = text.indexOf("alchemy_requestFeePayer failed");
  const start = sponsorAt !== -1 && sponsorAt < simulationAt ? sponsorAt : simulationAt;
  const nodeText = text.slice(start);
  const marker = "Simulation logs:";
  const markerAt = nodeText.indexOf(marker);
  if (markerAt === -1) return nodeText.trim();
  const headline = nodeText
    .slice(0, markerAt)
    .trim()
    .replace(/[.\s]+$/, "");
  const logs = nodeText
    .slice(markerAt + marker.length)
    .split(/\s*\|\s*|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return [headline, ...logs.map((line) => `  ${line}`)].join("\n");
}

/**
 * Rewraps a raw sponsored-send error as AcpSendError: message is the node's
 * own error reformatted one simulation log per line, with the retry guard's
 * diagnosis attached when it confirmed the failure. Errors without simulation
 * logs (network, auth, server) pass through unchanged. The original error is
 * always preserved as `cause`.
 */
export function decorateSendError(
  err: unknown,
  diagnosis: JobStateDiagnosis | null,
): unknown {
  const node = formatNodeError(err);
  if (node === null) return err;
  return new AcpSendError(node, err, diagnosis);
}
