import type { NetworkContext } from "./chains.js";
import type { Call, Hex } from "viem";
import type { SolanaInstructionLike } from "../providers/types.js";

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
  clientAddress?: string;
  /**
   * Hook opt_params, identical semantics on every chain: omitted or "0x"
   * proposes nothing. For a fund-transfer fund request encode via
   * encodeFundTransferSetBudgetOptParams(chainId, token, amount, destination)
   * — F-82: budget-mint amounts may exceed the job budget (fund() then
   * authorizes with a client-signed Approve/Revoke bracket); token = the
   * default pubkey cancels a live proposal (Solana).
   */
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
  expectedBudget: bigint;
  clientAddress?: string;
  optParams?: Hex;
};

export type SubmitParams = {
  jobId: bigint;
  deliverable: string;
  clientAddress?: string;
  optParams?: Hex;
};

export type CompleteParams = {
  jobId: bigint;
  reason: string;
  clientAddress?: string;
  optParams?: Hex;
};

export type RejectParams = {
  jobId: bigint;
  reason: string;
  clientAddress?: string;
  optParams?: Hex;
};

export type BatchConfigureHooksParams = {
  routerAddress: string;
  jobId: bigint;
  selectors: Hex[];
  hooksPerSelector: string[][];
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
