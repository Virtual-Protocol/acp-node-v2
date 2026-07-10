// Retry guard for guarded fee-payer errors (WrongStatus, 6015 / 0x177f).
//
// Alchemy's sponsor node simulates against its own RPC, which can lag ours by
// a few slots (see providers/solana/feePayerRetry.ts). A WrongStatus failure
// is therefore ambiguous: either the sponsor has not yet seen the transaction
// that moved the job into the required state (safe to retry), or the job
// genuinely is in the wrong state — e.g. already Completed by a duplicate
// evaluation event (retrying is pointless and only delays the real error).
//
// The guard disambiguates by asking OUR read RPC: for every state-gated ACP
// instruction in the batch, fetch the job account and check whether its
// current state satisfies that instruction's precondition. If our node says
// the transaction can succeed, the sponsor was stale — retry. If our node
// agrees the precondition is unmet, the error is genuine — fail fast.

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

type StateGate = {
  discriminator: Uint8Array;
  /** Index of the `job` account in the instruction's account list. */
  jobAccountIndex: number;
  /**
   * Job states in which the instruction's status check passes. Kept generous
   * (never narrower than the program's actual check): a state wrongly listed
   * here only costs extra retries before the genuine error propagates, while
   * a state wrongly missing would abort a recoverable lag retry.
   */
  allowedStates: JobState[];
  /**
   * The program rejects this instruction past job.expiredAt even though the
   * state enum still allows it (state flips to Expired only on claim_refund).
   * Set only on proof — a wrong true aborts recoverable lag retries.
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
 * one state-gated instruction of `acpProgramAddress` AND every such
 * instruction's job account, as seen by `rpc`, is in a state its precondition
 * allows. When it refuses because a job-state precondition is unmet, the
 * refusal's details are available via `lastDiagnosis()`.
 */
export function buildJobStateRetryGuard(
  rpc: Rpc<SolanaRpcApi>,
  acpProgramAddress: Address,
  instructions: SolanaInstructionLike[],
): JobStateRetryGuard {
  let diagnosis: JobStateDiagnosis | null = null;
  const guard = async (): Promise<boolean> => {
    diagnosis = null;
    let sawGatedInstruction = false;
    for (const ix of instructions) {
      if (ix.programAddress !== acpProgramAddress) continue;
      const gate = STATE_GATES.find((g) =>
        startsWith(ix.data, g.discriminator),
      );
      if (!gate) continue;
      const jobAddress = ix.accounts[gate.jobAccountIndex]?.address;
      if (!jobAddress) return false;
      sawGatedInstruction = true;

      const job = await fetchMaybeJob(rpc, jobAddress, {
        commitment: ACP_COMMITMENT,
      });
      const stateOk =
        job.exists && gate.allowedStates.includes(job.data.state);
      // Even when the state enum allows the instruction, the program rejects
      // clock-gated instructions past job.expiredAt (the state is not flipped
      // to Expired until claim_refund). Retrying cannot fix an expired job.
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
