import type { NetworkContext } from "./chains.js";
import type { Call, Hex } from "viem";
import type {
  SendInstructionsOptions,
  SolanaInstructionLike,
} from "../providers/types.js";

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
  /**
   * Send options the client attaches at prepare time and `submitPrepared`
   * forwards to the adapter. Any lookup table named here must already exist
   * on-chain — prepare has no creation side-effect.
   */
  sendOptions?: SendInstructionsOptions;
};

export type PreparedTx = PreparedEvmTx | PreparedSolanaTx;
export type PreparedTxInput = PreparedTx[];

/**
 * A job's identifier, in whichever form the chain gives it its identity: the
 * contract's counter on EVM, the job account's own base58 ADDRESS on Solana.
 */
export type JobId = bigint | string;

export type CreateJobParams = {
  providerAddress: string;
  evaluatorAddress: string;
  expiredAt: number;
  description: string;
  hookAddress?: string;
  optParams?: Hex;
};

/**
 * Subscription terms proposed by the provider at setBudget on a multi-hook
 * (router) job: stored as proposed_terms, confirmed at fund, activated at
 * complete.
 */
export type SubscriptionTermsInput = {
  /** Subscription duration in seconds (the hook rejects non-positive). */
  duration: bigint;
  packageId: bigint;
};

export type SetBudgetParams = {
  jobId: JobId;
  amount: bigint;
  clientAddress?: string;
  /**
   * Hook opt_params; omitted or "0x" proposes nothing. Encode a fund-transfer
   * request via encodeFundTransferSetBudgetOptParams(chainId, token, amount,
   * destination); the default pubkey as token cancels a live proposal.
   *
   * On a Solana router job this carries ONLY the fund-transfer slice — the
   * client assembles the multi-hook header itself.
   */
  optParams?: Hex;
  /**
   * Multi-hook (router) jobs only: subscription terms to propose. Ignored on
   * single-hook jobs. On EVM the terms ride inside optParams instead.
   */
  subscriptionTerms?: SubscriptionTermsInput;
};

export type ApproveAllowanceParams = {
  tokenAddress: string;
  spenderAddress: string;
  amount: bigint;
  optParams?: Hex;
};

export type FundParams = {
  jobId: JobId;
  expectedBudget: bigint;
  clientAddress?: string;
  optParams?: Hex;
};

export type SubmitParams = {
  jobId: JobId;
  deliverable: string;
  clientAddress?: string;
  optParams?: Hex;
};

export type CompleteParams = {
  jobId: JobId;
  reason: string;
  clientAddress?: string;
  optParams?: Hex;
};

export type RejectParams = {
  jobId: JobId;
  reason: string;
  clientAddress?: string;
  optParams?: Hex;
};

export type BatchConfigureHooksParams = {
  routerAddress: string;
  jobId: JobId;
  selectors: Hex[];
  hooksPerSelector: string[][];
};

export type OnChainJob = {
  id: JobId;
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  hook: string;
};
