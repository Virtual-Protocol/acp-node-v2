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
  deliverableHash: string;
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
  onChainJobId: string;
  chainId: number;
  event: AcpJobEvent;
  timestamp: number;
};

export type AgentMessage = {
  kind: "message";
  onChainJobId: string;
  chainId: number;
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
  contractAddresses: Record<number, string>;
  providerSupportedChainIds: number[];
  client: AcpClient;
  signMessage: (chainId: number, message: string) => Promise<string>;
};

// ---------------------------------------------------------------------------
// Off-chain intent shape (returned by the backend REST API)
// ---------------------------------------------------------------------------

export type OffChainIntent = {
  intentId: string;
  actor: string;
  isEscrow: boolean;
  isSigned: boolean;
  fromAddress: string;
  recipientAddress: string;
  amount: string | null;
  tokenAddress: string | null;
};

// ---------------------------------------------------------------------------
// Off-chain job shape (returned by the backend REST API)
// ---------------------------------------------------------------------------

export type OffChainJob = {
  chainId: number;
  onChainJobId: string;
  jobStatus: string;
  clientAddress: string;
  providerAddress: string;
  evaluatorAddress: string;
  description: string | null;
  budget: string | null;
  expiredAt: string;
  hookAddress: string | null;
  deliverable: string | null;
  intents?: OffChainIntent[];
};

// ---------------------------------------------------------------------------
// Transport interfaces
// ---------------------------------------------------------------------------

export interface AcpChatTransport {
  connect(onConnected?: () => void): Promise<void>;
  disconnect(): Promise<void>;

  onEntry(handler: (entry: JobRoomEntry) => void): void;
  sendMessage(
    chainId: number,
    jobId: string,
    content: string,
    contentType?: string
  ): void;
  postMessage(
    chainId: number,
    jobId: string,
    content: string,
    contentType?: string
  ): Promise<void>;
  getHistory(chainId: number, jobId: string): Promise<JobRoomEntry[]>;
}

export interface AcpJobApi {
  getActiveJobs(): Promise<{ chainId: number; onChainJobId: string }[]>;
  getJob(chainId: number, jobId: string): Promise<OffChainJob | null>;
  postDeliverable(
    chainId: number,
    jobId: string,
    deliverable: string
  ): Promise<void>;
}

