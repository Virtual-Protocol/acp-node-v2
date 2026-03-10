import type { NetworkContext } from "./chains";
import type { Call, Hex } from "viem";
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
  optParams?: Hex;
};

export type SetBudgetParams = {
  jobId: bigint;
  amount: bigint;
  optParams?: Hex;
};

export type ApproveAllowanceParams = {
  tokenAddress: string;
  spenderAddress: string;
  amount: bigint;
  optParams?: Hex;
};

export type FundParams = {
  jobId: bigint;
  optParams?: Hex;
};

export type SubmitParams = {
  jobId: bigint;
  deliverable: string;
  optParams?: Hex;
};

export type CompleteParams = {
  jobId: bigint;
  reason: string;
  optParams?: Hex;
};

export type RejectParams = {
  jobId: bigint;
  reason: string;
  optParams?: Hex;
};

export type OnChainJob = {
  id: bigint;
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  hook: string;
};
