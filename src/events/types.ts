import type { AcpClient } from "../clientFactory";
import type { AcpAgent } from "../acpAgent";

// ---------------------------------------------------------------------------
// ACP job events (discriminated union)
// ---------------------------------------------------------------------------

export type JobCreatedEvent = {
  type: "job.created";
  jobId: bigint;
  client: string;
  provider: string;
  evaluator: string;
  expiredAt: bigint;
  hook: string;
};

export type BudgetSetEvent = {
  type: "budget.set";
  jobId: bigint;
  amount: bigint;
};

export type JobFundedEvent = {
  type: "job.funded";
  jobId: bigint;
  client: string;
  amount: bigint;
};

export type JobSubmittedEvent = {
  type: "job.submitted";
  jobId: bigint;
  provider: string;
  deliverable: string;
};

export type JobCompletedEvent = {
  type: "job.completed";
  jobId: bigint;
  evaluator: string;
  reason: string;
};

export type JobRejectedEvent = {
  type: "job.rejected";
  jobId: bigint;
  rejector: string;
  reason: string;
};

export type JobExpiredEvent = {
  type: "job.expired";
  jobId: bigint;
};

export type AcpJobEvent =
  | JobCreatedEvent
  | BudgetSetEvent
  | JobFundedEvent
  | JobSubmittedEvent
  | JobCompletedEvent
  | JobRejectedEvent
  | JobExpiredEvent;

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

export type AcpEventHandlers = {
  onJobCreated?: (event: JobCreatedEvent, agent: AcpAgent) => Promise<void>;
  onBudgetSet?: (event: BudgetSetEvent, agent: AcpAgent) => Promise<void>;
  onJobFunded?: (event: JobFundedEvent, agent: AcpAgent) => Promise<void>;
  onJobSubmitted?: (
    event: JobSubmittedEvent,
    agent: AcpAgent
  ) => Promise<void>;
  onJobCompleted?: (
    event: JobCompletedEvent,
    agent: AcpAgent
  ) => Promise<void>;
  onJobRejected?: (
    event: JobRejectedEvent,
    agent: AcpAgent
  ) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

export type TransportContext = {
  agentAddress: string;
  contractAddress: string;
  client: AcpClient;
  agent: AcpAgent;
};

export interface AcpTransport {
  start(ctx: TransportContext, handlers: AcpEventHandlers): Promise<void>;
  stop(): Promise<void>;
}
