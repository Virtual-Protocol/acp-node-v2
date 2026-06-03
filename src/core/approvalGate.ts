import { BaseError } from "viem";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./constants.js";

export type ApprovalEvent = {
  kind: "approval";
  approvalId: string;
  status: "approved" | "rejected";
  result?: unknown;
  reason?: string;
  timestamp: number;
};

type Pending = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const pending = new Map<string, Pending>();

export class ApprovalRequiredError extends BaseError {
  readonly code = "APPROVAL_REQUIRED";
  constructor(
    readonly approvalId: string,
    readonly approvalUrl: string,
    detail: string
  ) {
    super(detail, {
      details: `approvalId=${approvalId} approvalUrl=${approvalUrl}`,
    });
    this.name = "ApprovalRequiredError";
  }
}

export class ApprovalRejectedError extends Error {
  constructor(readonly approvalId: string, reason?: string) {
    super(reason ?? `Approval ${approvalId} was rejected`);
    this.name = "ApprovalRejectedError";
  }
}

export class ApprovalTimeoutError extends Error {
  constructor(readonly approvalId: string, timeoutMs: number) {
    super(`Approval ${approvalId} timed out after ${timeoutMs}ms`);
    this.name = "ApprovalTimeoutError";
  }
}

export function awaitApproval<T>(
  approvalId: string,
  opts: { timeoutMs?: number } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    const existing = pending.get(approvalId);
    if (existing) {
      reject(new Error(`Approval ${approvalId} is already being awaited`));
      return;
    }

    const timer = setTimeout(() => {
      pending.delete(approvalId);
      reject(new ApprovalTimeoutError(approvalId, timeoutMs));
    }, timeoutMs);

    pending.set(approvalId, {
      resolve: (result) => resolve(result as T),
      reject,
      timer,
    });
  });
}

export function resolveApproval(
  approvalId: string,
  status: "approved" | "rejected",
  result?: unknown,
  reason?: string
): boolean {
  const entry = pending.get(approvalId);
  if (!entry) return false;
  pending.delete(approvalId);
  if (entry.timer) clearTimeout(entry.timer);
  if (status === "approved") {
    entry.resolve(result);
  } else {
    entry.reject(new ApprovalRejectedError(approvalId, reason));
  }
  return true;
}
