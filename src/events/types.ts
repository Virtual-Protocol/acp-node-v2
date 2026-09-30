import type { AcpClient } from "../clientFactory.js";
import { AgentSort, BrowseMode, OnlineStatus } from "../clients/baseAcpClient.js";

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

export type FundIntent = {
  amount: number;
  tokenAddress: string;
  symbol: string;
  recipient: string;
};

export type BudgetSetEvent = {
  type: "budget.set";
  jobId: string;
  amount: number;
  fundRequest?: FundIntent;
};

export type JobFundedEvent = {
  type: "job.funded";
  jobId: string;
  client: string;
  amount: number;
};

export type JobSubmittedEvent = {
  type: "job.submitted";
  jobId: string;
  provider: string;
  deliverableHash: string;
  deliverable: string;
  fundTransfer?: FundIntent;
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
  contentType:
    | "text"
    | "proposal"
    | "deliverable"
    | "structured"
    | "requirement";
  content: string;
  timestamp: number;
  packageId?: number;
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
  agentAddresses: Record<string, string>;
  contractAddresses: Record<number, string>;
  providerSupportedChainIds: number[];
  getClientForChain: (chainId: number) => AcpClient;
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
// ACP job status
// ---------------------------------------------------------------------------

export enum AcpJobStatus {
  OPEN = "OPEN",
  FUNDED = "FUNDED",
  SUBMITTED = "SUBMITTED",
  COMPLETED = "COMPLETED",
  REJECTED = "REJECTED",
  EXPIRED = "EXPIRED",
}

// ---------------------------------------------------------------------------
// Off-chain job shape (returned by the backend REST API)
// ---------------------------------------------------------------------------

export type OffChainJob = {
  chainId: number;
  onChainJobId: string;
  jobStatus: AcpJobStatus;
  clientAddress: string;
  providerAddress: string;
  evaluatorAddress: string;
  description: string | null;
  budget: string | null;
  expiredAt: string;
  hookAddress: string | null;
  deliverable: string | null;
  intents?: OffChainIntent[];
  hookConfigs: Record<string, string[]> | null;
  clientSubscription: OffChainSubscription | null;
};

export type OffChainSubscription = {
  packageId: number;
  name: string;
  price: number;
  /** Subscription duration in seconds. */
  duration: number;
};

// ---------------------------------------------------------------------------
// Transport interfaces
// ---------------------------------------------------------------------------

export type SupportedStreams = "chat" | "wallet";

export interface AcpChatTransport {
  connect(
    onConnected?: () => void,
    streams?: SupportedStreams[],
  ): Promise<void>;
  disconnect(): Promise<void>;

  onEntry(handler: (entry: JobRoomEntry) => void): void;
  sendMessage(
    chainId: number,
    jobId: string,
    content: string,
    contentType?: string,
    packageId?: number,
  ): void;
  postMessage(
    chainId: number,
    jobId: string,
    content: string,
    contentType?: string,
    packageId?: number,
  ): Promise<void>;
  getHistory(chainId: number, jobId: string): Promise<JobRoomEntry[]>;
}

export interface BrowseAgentParams {
  cluster?: string;
  sortBy?: AgentSort[];
  topK?: number;
  isOnline?: OnlineStatus;
  showHidden?: boolean; // include hidden offerings and resources
  walletAddressToExclude?: string;
  browseMode?: BrowseMode; // result ordering: relevance (default) | recency | mixed
  mixNewCount?: number; // MIXED mode: how many new agents to interleave
}

export interface AcpJobApi {
  getActiveJobs(): Promise<{ chainId: number; onChainJobId: string }[]>;
  getJob(chainId: number, jobId: string): Promise<OffChainJob | null>;
  postDeliverable(
    chainId: number,
    jobId: string,
    deliverable: string,
  ): Promise<void>;
  browseAgents(
    keyword: string,
    chainIds: number[],
    params?: BrowseAgentParams,
  ): Promise<Array<AcpAgentDetail>>;
  getAgentByWalletAddress(
    walletAddress: string,
  ): Promise<AcpAgentDetail | null>;
}

export interface AcpAgentChain {
  id: number;
  chainId: number;
  tokenAddress: string;
}

export interface AcpAgentOffering {
  name: string;
  description: string;
  deliverable: Record<string, unknown> | string;
  requirements: Record<string, unknown> | string;
  slaMinutes: number;
  priceType: string;
  priceValue: number;
  requiredFunds: boolean;
  /**
   * Off-escrow proportional-fee offerings (`priceType` "percentage" with
   * `requiredFunds: false`): names the requirement field carrying the fee
   * notional in atomic units, e.g. "notionalAtomic". The fee is computed as a
   * proportion of that value via {@link computePercentageFee} — the SDK never
   * derives it from custodied capital. Undefined for flat-fee and custodial
   * offerings. See `src/core/fee.ts` and the `off-escrow-percentage` example.
   */
  feeBasisField?: string;
  isHidden: boolean;
  isPrivate: boolean;
  subscriptions?: Array<AcpAgentSubscription>;
}

/**
 * Known `AcpAgentOffering.priceType` values.
 * - `FIXED`: flat fee; `priceValue` is the fee amount.
 * - `PERCENTAGE`: proportional fee; `priceValue` is a rate applied to the fee
 *   notional (see {@link AcpAgentOffering.feeBasisField} and
 *   `computePercentageFee`). Whether `priceValue` is basis points or percent is
 *   a backend convention — pass the matching `FeeUnit`.
 */
export const PRICE_TYPE = {
  FIXED: "fixed",
  PERCENTAGE: "percentage",
} as const;

export type PriceType = (typeof PRICE_TYPE)[keyof typeof PRICE_TYPE];

export interface AcpAgentResource {
  name: string;
  url: string;
  params: Record<string, unknown>;
  description: string;
}

export interface AcpAgentSubscription {
  packageId: number;
  name: string;
  price: number;
  duration: number;
}

export interface AcpAgentDetail {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  walletAddress: string;
  solWalletAddress: string;
  role: string;
  cluster: string | null;
  tag: string | null;
  lastActiveAt: string;
  rating: number | null;
  isHidden: boolean;
  chains: Array<AcpAgentChain>;
  offerings: Array<AcpAgentOffering>;
  resources: Array<AcpAgentResource>;
  subscriptions: Array<AcpAgentSubscription>;
  // Present when the backend tags discovery results: a recently-created
  // (unproven) agent. Lets clients surface a "NEW" indicator.
  isNew?: boolean;
}
