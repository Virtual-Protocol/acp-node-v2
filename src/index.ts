// Primary API
export * from "./acpAgent.js";
export * from "./acpJob.js";
export * from "./jobSession.js";

// Client layer
export * from "./clientFactory.js";
export * from "./clients/baseAcpClient.js";
export * from "./clients/evmAcpClient.js";
export * from "./clients/solanaAcpClient.js";
export * from "./clients/solanaMultiHookClient.js";
export * as solanaMultiHook from "./core/solana/multiHook.js";

// Core types
export * from "./core/acpAbi.js";
export * from "./core/chains.js";
export * from "./core/constants.js";
export * from "./core/assetToken.js";
export * from "./core/approvalGate.js";

// Provider interfaces & adapters
export * from "./providers/types.js";
export * from "./providers/evm/viemProviderAdapter.js";
export * from "./providers/evm/privyAlchemyEvmProviderAdapter.js";
export * from "./providers/solana/solanaProviderAdapter.js";
export * from "./providers/solana/keypairSolanaProviderAdapter.js";
export * from "./providers/solana/privySolanaProviderAdapter.js";

// Solana constants
export * from "./core/solana/constants.js";
export * from "./core/solana/wallet.js";

// Transport & API
export { AcpHttpClient } from "./events/acpHttpClient.js";
export { AcpApiClient } from "./events/acpApiClient.js";
export { SseTransport, STREAMS } from "./events/sseTransport.js";

// Public enums
export { AcpJobStatus } from "./events/types.js";

// Event / room types (public)
export type {
  TransportContext,
  AcpJobEvent,
  AcpJobEventType,
  JobCreatedEvent,
  BudgetSetEvent,
  JobFundedEvent,
  JobSubmittedEvent,
  JobCompletedEvent,
  JobRejectedEvent,
  JobExpiredEvent,
  JobRoomEntry,
  SystemEntry,
  AgentMessage,
  AcpTool,
  AcpToolParameter,
  AgentRole,
  AcpChatTransport,
  AcpJobApi,
  OffChainJob,
  OffChainIntent,
  AcpAgentDetail,
  AcpAgentOffering,
  AcpAgentChain,
  AcpAgentResource,
  AcpAgentSubscription,
  BrowseAgentParams,
  FundIntent,
  SupportedStreams,
} from "./events/types.js";

// Utilities
export * from "./utils/events.js";
