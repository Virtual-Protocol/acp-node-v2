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
   * Optional send options the client attaches at prepare time and
   * `submitPrepared` forwards to the adapter — e.g. a persistent lookup table
   * to compress against plus `sponsorLookupTables` (router reject). The
   * lookup table must already exist on-chain (no creation side-effect at
   * prepare time).
   */
  sendOptions?: SendInstructionsOptions;
};

export type PreparedTx = PreparedEvmTx | PreparedSolanaTx;
export type PreparedTxInput = PreparedTx[];

/**
 * A job's identifier, in whichever form the chain gives it its identity.
 *
 * EVM: the contract's counter, a bigint.
 *
 * Solana: the job account's own base58 ADDRESS. The u64 `seed` behind the
 * PDA is a write-once derivation input, not an identifier.
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
 * (router) job. The subscription hook stores them as the job's proposed_terms;
 * the client confirms them at fund and activation happens at complete.
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
   * Hook opt_params, identical semantics on every chain: omitted or "0x"
   * proposes nothing. For a fund-transfer fund request encode via
   * encodeFundTransferSetBudgetOptParams(chainId, token, amount, destination)
   * — budget-mint amounts may exceed the job budget (fund() then
   * authorizes with a client-signed Approve/Revoke bracket); token = the
   * default pubkey cancels a live proposal (Solana).
   *
   * On a Solana multi-hook (router) job this carries ONLY the fund-transfer
   * slice; the client assembles the multi-hook header itself so the declared
   * account counts always match the slices it builds.
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
