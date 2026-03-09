import type { NetworkContext } from "./chains";
import type { Call } from "viem";
import type { SolanaInstructionLike } from "../providers/types";

export type CapabilityFlags = {
  supportsBatch: boolean;
  supportsAllowance: boolean;
};

export type OperationResult<TTx, TRaw = unknown> = {
  tx: TTx;
  chain: NetworkContext["family"];
  network: NetworkContext["network"];
  raw?: TRaw;
};

export type PreparedEvmTx = OperationResult<Call[]> & {
  chain: "evm";
};

export type PreparedSolanaTx = OperationResult<SolanaInstructionLike[]> & {
  chain: "solana";
};

export type PreparedTx = PreparedEvmTx | PreparedSolanaTx;
export type PreparedTxInput = PreparedTx[];

export type CreateJobParams = {
  providerAddress: string;
  evaluatorAddress: string;
  expiredAt: number;
  description: string;
  hookAddress?: string;
  optParams?: Record<string, unknown>;
};

export type SetBudgetParams = {
  jobId: bigint;
  amount: bigint;
  optParams?: Record<string, unknown>;
};

export type ApproveAllowanceParams = {
  tokenAddress: string;
  spenderAddress: string;
  amount: bigint;
  optParams?: Record<string, unknown>;
};

export type FundParams = {
  jobId: bigint;
  optParams?: Record<string, unknown>;
};

export type SubmitParams = {
  jobId: bigint;
  deliverable: string;
  optParams?: Record<string, unknown>;
};

export type CompleteParams = {
  jobId: bigint;
  reason: string;
  optParams?: Record<string, unknown>;
};

export type RejectParams = {
  jobId: bigint;
  reason: string;
  optParams?: Record<string, unknown>;
};
