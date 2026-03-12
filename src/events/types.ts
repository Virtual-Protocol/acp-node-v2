import type { AcpClient } from "../clientFactory";

// ---------------------------------------------------------------------------
// ACP job events (discriminated union — used inside SystemEntry.event)
// ---------------------------------------------------------------------------

export type JobCreatedEvent = {
  type: "job.created";
  jobId: string;
  client: string;
  provider: string;
  evaluator: string;
  expiredAt: string;
  hook: string;
};

export type BudgetSetEvent = {
  type: "budget.set";
  jobId: string;
  amount: string;
};

export type JobFundedEvent = {
  type: "job.funded";
  jobId: string;
  client: string;
  amount: string;
};

export type JobSubmittedEvent = {
  type: "job.submitted";
  jobId: string;
  provider: string;
  deliverable: string;
};

export type JobCompletedEvent = {
  type: "job.completed";
  jobId: string;
  evaluator: string;
  reason: string;
};

export type JobRejectedEvent = {
  type: "job.rejected";
  jobId: string;
  rejector: string;
  reason: string;
};

export type JobExpiredEvent = {
  type: "job.expired";
  jobId: string;
};

export type AcpJobEvent =
  | JobCreatedEvent
  | BudgetSetEvent
  | JobFundedEvent
  | JobSubmittedEvent
  | JobCompletedEvent
  | JobRejectedEvent
  | JobExpiredEvent;

export type AcpJobEventType = AcpJobEvent["type"];

// ---------------------------------------------------------------------------
// Job room entry types (mirrors acp-chat-v2 types)
// ---------------------------------------------------------------------------

export type SystemEntry = {
  kind: "system";
  jobId: string;
  event: AcpJobEvent;
  timestamp: number;
};

export type AgentMessage = {
  kind: "message";
  jobId: string;
  from: string;
  contentType: "text" | "proposal" | "deliverable" | "structured";
  content: string;
  timestamp: number;
};

export type JobRoomEntry = SystemEntry | AgentMessage;

// ---------------------------------------------------------------------------
// ACP tool definition (for LLM function-calling integration)
// ---------------------------------------------------------------------------

export type AcpToolParameter = {
  name: string;
  type: string;
  description: string;
  required?: boolean;
};

export type AcpTool = {
  name: string;
  description: string;
  parameters: AcpToolParameter[];
};

// ---------------------------------------------------------------------------
// Agent role
// ---------------------------------------------------------------------------

export type AgentRole = "client" | "provider" | "evaluator";

// ---------------------------------------------------------------------------
// Transport context (shared state passed to transports on connect)
// ---------------------------------------------------------------------------

export type TransportContext = {
  agentAddress: string;
  contractAddress: string;
  client: AcpClient;
};

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

export interface AcpTransport {
  connect(ctx: TransportContext): Promise<void>;
  disconnect(): Promise<void>;

  onEntry(handler: (entry: JobRoomEntry) => void): void;
  sendMessage(
    jobId: string,
    content: string,
    contentType?: string,
  ): void;
  getHistory(jobId: string): Promise<JobRoomEntry[]>;
  getActiveJobs(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Transport configuration (user-facing, passed to AcpAgent.create)
// ---------------------------------------------------------------------------

export type SocketTransportConfig = {
  type: "socket";
  url: string;
};

export type TransportConfig = SocketTransportConfig;
