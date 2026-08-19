import type { JobRoomEntry } from "./types.js";

/**
 * Stable content key for a room entry.
 *
 * `JobRoomEntry` carries no server-assigned id, and the same logical entry
 * reaches the SDK as a different object on every path that produces it — an SSE
 * frame and a `getHistory()` response each `JSON.parse` their own copy. Compare
 * by reference and one entry looks like several, which is what lets a handler
 * run twice on a single event.
 *
 * This answers "is this the entry I already have?" for one process. It is not a
 * substitute for the persistent dedup an agent needs across restarts — see
 * "Restart & replay semantics" in the README. That store records what you
 * *acted on*; this records what you've *seen*, and dies with the process.
 */
export function entryKey(entry: JobRoomEntry): string {
  const base = `${entry.chainId}:${entry.onChainJobId}:${entry.timestamp}:${entry.kind}`;
  return entry.kind === "message"
    ? `${base}:${entry.from.toLowerCase()}:${entry.contentType}:${entry.content}`
    : `${base}:${entry.event.type}`;
}
