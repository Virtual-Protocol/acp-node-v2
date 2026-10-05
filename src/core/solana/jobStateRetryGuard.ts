// Retry guard for guarded fee-payer errors (WrongStatus, router InvalidJob on
// BatchConfigureHooks, subscription-hook JobNotExpired on
// CleanupProposedTerms).
//
// Each of those is ambiguous: the sponsor node may simply not have seen the
// transaction that moved the job into the required state, or the job may
// genuinely be in the wrong state.
//
// The guard disambiguates by asking OUR read RPC: for every state-gated
// instruction in the batch, fetch the job account and check its current state
// against that instruction's precondition. Our node saying it can succeed
// means the sponsor was stale; our node agreeing means fail fast.

import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import type { SolanaInstructionLike } from "../../providers/types.js";
import { ACP_COMMITMENT } from "../constants.js";
import { fetchMaybeJob } from "./generated/acp/accounts/job.js";
import { JobState } from "./generated/acp/types/jobState.js";
import { SET_BUDGET_DISCRIMINATOR } from "./generated/acp/instructions/setBudget.js";
import { FUND_DISCRIMINATOR } from "./generated/acp/instructions/fund.js";
import { SUBMIT_DISCRIMINATOR } from "./generated/acp/instructions/submit.js";
import { COMPLETE_DISCRIMINATOR } from "./generated/acp/instructions/complete.js";
import { REJECT_DISCRIMINATOR } from "./generated/acp/instructions/reject.js";
import { BATCH_CONFIGURE_HOOKS_DISCRIMINATOR } from "./generated/multi-hook-router/instructions/batchConfigureHooks.js";
import { CLEANUP_PROPOSED_TERMS_DISCRIMINATOR } from "./generated/subscription-hook/instructions/cleanupProposedTerms.js";

type StateGate = {
  discriminator: Uint8Array;
  /** Index of the `job` account in the instruction's account list. */
  jobAccountIndex: number;
  /**
   * Job states in which the instruction's status check passes. Keep generous,
   * never narrower than the program's own check.
   */
  allowedStates: JobState[];
  /**
   * The program rejects this instruction past job.expiredAt even though the
   * state enum still allows it. Set only on proof.
   */
  expiryGated?: boolean;
};

/**
 * Why the guard refused a retry: the failing job-state precondition and the
 * state our own read RPC actually saw. Exposed as AcpSendError.diagnosis.
 */
export interface JobStateDiagnosis {
  jobAddress: string;
  /** False when the job account does not exist on our read RPC. */
  jobExists: boolean;
  /** On-chain state our read RPC saw; null when the account is missing. */
  actualState: JobState | null;
  allowedStates: JobState[];
  /**
   * Set (unix seconds) when the refusal is because the job's expiry passed
   * while the state enum still allowed the instruction; null otherwise.
   */
  expiredAt: bigint | null;
}

export interface JobStateRetryGuard {
  /** Pass as FeePayerRetryOptions.retryGuard. */
  guard: () => Promise<boolean>;
  /**
   * Diagnosis from the most recent guard() call that returned false because
   * a job-state precondition was unmet; null if the guard never refused.
   */
  lastDiagnosis: () => JobStateDiagnosis | null;
}

// Job state machine (see generated/acp/types/jobState.ts):
//   Funded path:      Open -> Funded -> Submitted -> Completed | Rejected | Expired
//   Zero-budget path: Open -> Submitted -> Completed | Rejected
//   Open jobs can also be Rejected directly.
const STATE_GATES: StateGate[] = [
  {
    discriminator: SET_BUDGET_DISCRIMINATOR,
    jobAccountIndex: 1,
    allowedStates: [JobState.Open],
    expiryGated: true,
  },
  {
    discriminator: FUND_DISCRIMINATOR,
    jobAccountIndex: 1,
    allowedStates: [JobState.Open],
    expiryGated: true,
  },
  {
    discriminator: SUBMIT_DISCRIMINATOR,
    jobAccountIndex: 2,
    allowedStates: [JobState.Open, JobState.Funded],
    expiryGated: true,
  },
  {
    discriminator: COMPLETE_DISCRIMINATOR,
    jobAccountIndex: 2,
    allowedStates: [JobState.Submitted],
    expiryGated: true,
  },
  {
    discriminator: REJECT_DISCRIMINATOR,
    jobAccountIndex: 2,
    allowedStates: [JobState.Open, JobState.Funded, JobState.Submitted],
  },
];

// Router-program instructions gated on the same ACP job account. Hook
// configuration locks once the job leaves Open. No expiry gate: the router
// checks only job.state.
const ROUTER_STATE_GATES: StateGate[] = [
  {
    discriminator: BATCH_CONFIGURE_HOOKS_DISCRIMINATOR,
    jobAccountIndex: 1,
    allowedStates: [JobState.Open],
  },
];

// Subscription-hook instructions gated on the ACP job account. Cleanup of an
// abandoned ProposedTerms PDA requires job.state == Expired, with its job
// account at index 2: caller, hook_state, job_account, proposed_terms,
// acp_state, platform_treasury. No expiry gate — Expired IS the state wanted.
const SUB_HOOK_STATE_GATES: StateGate[] = [
  {
    discriminator: CLEANUP_PROPOSED_TERMS_DISCRIMINATOR,
    jobAccountIndex: 2,
    allowedStates: [JobState.Expired],
  },
];

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Builds a `retryGuard` (see FeePayerRetryOptions) for a batch of
 * instructions. The guard returns true only when the batch contains at least
 * one state-gated instruction of `acpProgramAddress` (or, when provided, of
 * `routerProgramAddress` / `subscriptionHookProgramAddress`) AND every such
 * instruction's job account, as seen by `rpc`, is in a state its precondition
 * allows. When it refuses because a job-state precondition is unmet, the
 * refusal's details are available via `lastDiagnosis()`.
 */
export function buildJobStateRetryGuard(
  rpc: Rpc<SolanaRpcApi>,
  acpProgramAddress: Address,
  instructions: SolanaInstructionLike[],
  routerProgramAddress?: Address,
  subscriptionHookProgramAddress?: Address,
): JobStateRetryGuard {
  let diagnosis: JobStateDiagnosis | null = null;
  const guard = async (): Promise<boolean> => {
    diagnosis = null;
    let sawGatedInstruction = false;
    for (const ix of instructions) {
      let gates: StateGate[];
      if (ix.programAddress === acpProgramAddress) {
        gates = STATE_GATES;
      } else if (
        routerProgramAddress !== undefined &&
        ix.programAddress === routerProgramAddress
      ) {
        gates = ROUTER_STATE_GATES;
      } else if (
        subscriptionHookProgramAddress !== undefined &&
        ix.programAddress === subscriptionHookProgramAddress
      ) {
        gates = SUB_HOOK_STATE_GATES;
      } else {
        continue;
      }
      const gate = gates.find((g) => startsWith(ix.data, g.discriminator));
      if (!gate) continue;
      const jobAddress = ix.accounts[gate.jobAccountIndex]?.address;
      if (!jobAddress) return false;
      sawGatedInstruction = true;

      const job = await fetchMaybeJob(rpc, jobAddress, {
        commitment: ACP_COMMITMENT,
      });
      const stateOk =
        job.exists && gate.allowedStates.includes(job.data.state);
      // Clock-gated instructions are rejected past job.expiredAt even where
      // the state enum still allows them.
      const expired =
        stateOk &&
        gate.expiryGated === true &&
        job.exists &&
        job.data.expiredAt <= BigInt(Math.floor(Date.now() / 1000));
      if (!stateOk || expired) {
        diagnosis = {
          jobAddress,
          jobExists: job.exists,
          actualState: job.exists ? job.data.state : null,
          allowedStates: gate.allowedStates,
          expiredAt: expired && job.exists ? job.data.expiredAt : null,
        };
        return false;
      }
    }
    return sawGatedInstruction;
  };
  return { guard, lastDiagnosis: () => diagnosis };
}
