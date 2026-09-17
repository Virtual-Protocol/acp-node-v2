import type { AcpJob } from "../acpJob.js";
import type { AssetToken } from "./assetToken.js";

/** The exact transaction context evaluated immediately before job funding. */
export type FundPolicyContext = {
  action: "fund";
  job: AcpJob;
  chainId: number;
  jobId: bigint;
  providerAddress: string;
  clientAddress: string;
  amount: AssetToken;
};

export type FundPolicyDecision = {
  allow: boolean;
  reason?: string;
  /** Optional machine-readable material the policy used to reach its decision. */
  evidence?: unknown;
};

export type FundPolicy = (
  context: FundPolicyContext
) => FundPolicyDecision | Promise<FundPolicyDecision>;

/** Raised before any funding transaction when a configured policy denies it. */
export class FundPolicyDeniedError extends Error {
  readonly decision: FundPolicyDecision;

  constructor(decision: FundPolicyDecision) {
    super(decision.reason ?? "Funding denied by policy");
    this.name = "FundPolicyDeniedError";
    this.decision = decision;
  }
}

export async function enforceFundPolicy(
  policy: FundPolicy | undefined,
  context: FundPolicyContext
): Promise<void> {
  if (!policy) return;

  // A policy failure is deliberately fail-closed: throws propagate and an
  // explicit allow=true is required before the SDK prepares any transaction.
  const decision = await policy(context);
  if (!decision || decision.allow !== true) {
    throw new FundPolicyDeniedError(
      decision ?? { allow: false, reason: "Funding policy returned no decision" }
    );
  }
}
