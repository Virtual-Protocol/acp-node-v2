import { decodeEventLog, fromHex, type Log } from "viem";
import { ACP_ABI } from "../core/acpAbi";
import type { AcpJobEvent } from "./types";

const ACP_EVENT_NAMES = new Set([
  "JobCreated",
  "BudgetSet",
  "JobFunded",
  "JobSubmitted",
  "JobCompleted",
  "JobRejected",
  "JobExpired",
]);

function bytes32ToString(value: string): string {
  try {
    const trimmed = value.replace(/0+$/, "");
    if (trimmed === "0x" || trimmed === "") return "";
    return fromHex(trimmed as `0x${string}`, "string");
  } catch {
    return value;
  }
}

/**
 * Decodes a raw EVM log into a typed `AcpJobEvent`.
 * Returns `null` if the log doesn't match a known ACP job event.
 */
export function decodeAcpLog(log: Log): AcpJobEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: ACP_ABI,
      data: log.data,
      topics: log.topics,
    });

    if (!ACP_EVENT_NAMES.has(decoded.eventName)) return null;

    const args = decoded.args as Record<string, unknown>;

    switch (decoded.eventName) {
      case "JobCreated":
        return {
          type: "job.created",
          jobId: args.jobId as bigint,
          client: args.client as string,
          provider: args.provider as string,
          evaluator: args.evaluator as string,
          expiredAt: args.expiredAt as bigint,
          hook: args.hook as string,
        };

      case "BudgetSet":
        return {
          type: "budget.set",
          jobId: args.jobId as bigint,
          amount: args.amount as bigint,
        };

      case "JobFunded":
        return {
          type: "job.funded",
          jobId: args.jobId as bigint,
          client: args.client as string,
          amount: args.amount as bigint,
        };

      case "JobSubmitted":
        return {
          type: "job.submitted",
          jobId: args.jobId as bigint,
          provider: args.provider as string,
          deliverable: bytes32ToString(args.deliverable as string),
        };

      case "JobCompleted":
        return {
          type: "job.completed",
          jobId: args.jobId as bigint,
          evaluator: args.evaluator as string,
          reason: bytes32ToString(args.reason as string),
        };

      case "JobRejected":
        return {
          type: "job.rejected",
          jobId: args.jobId as bigint,
          rejector: args.rejector as string,
          reason: bytes32ToString(args.reason as string),
        };

      case "JobExpired":
        return {
          type: "job.expired",
          jobId: args.jobId as bigint,
        };

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Decodes an array of raw logs, returning only the ones that are
 * recognized ACP job events.
 */
export function decodeAcpLogs(logs: Log[]): AcpJobEvent[] {
  const events: AcpJobEvent[] = [];
  for (const log of logs) {
    const event = decodeAcpLog(log);
    if (event) events.push(event);
  }
  return events;
}
