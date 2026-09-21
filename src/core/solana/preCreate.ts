/**
 * Pre-creation of hook-rent PDAs at CPI stack height 2.
 *
 * Rent prefunding only reaches inner `createAccount`s a few CPI levels deep,
 * and router-mediated hook PDA creation sits below that. The pre_create_*
 * instructions allocate the same PDAs with a zero payload in a DIRECT
 * transaction, where the prefund sees them; the lifecycle handlers then accept
 * the pre-created accounts and overwrite the payload.
 *
 * All pre-creates are idempotent, payer MUST be the job's provider, and the
 * job must already exist.
 *
 * Pure instruction-building, so it unit-tests offline. IMPORTANT: always the
 * sync builder variants with an explicit `programAddress` — the generated
 * defaults are empty strings and the async variants derive PDAs from them.
 */
import type { Address, ReadonlyUint8Array } from "@solana/kit";

import { getPreCreateIntentInstruction } from "./generated/fund-transfer-hook/instructions/preCreateIntent.js";
import { getPreCreateProposedTermsInstruction } from "./generated/subscription-hook/instructions/preCreateProposedTerms.js";
import { getPreCreateSubExpiryInstruction } from "./generated/subscription-state/instructions/preCreateSubExpiry.js";
import {
  hookStatePda,
  intentPda,
  fundRequestIntentIdPda,
  providerEscrowIntentIdPda,
  proposedTermsPda,
  subExpiryPda,
} from "./multiHook.js";
import type { SolanaInstructionLike, SolanaSigner } from "../../providers/types.js";

export const INTENT_KIND_FUND_REQUEST = 0 as const;
export const INTENT_KIND_ESCROW = 1 as const;

/** Re-wrap a generated instruction as the provider-facing shape (same pattern
 * as the flow methods in solanaAcpClient). */
function toLike(ix: {
  programAddress: Address;
  accounts: readonly { address: Address; role: number }[];
  data: ReadonlyUint8Array | Uint8Array;
}): SolanaInstructionLike {
  return {
    programAddress: ix.programAddress,
    accounts: [...ix.accounts],
    data: ix.data as Uint8Array,
  };
}

export type PreCreateHookPdaArgs = {
  /** Required only when an intent pre-create is requested. */
  fundHook: Address | null;
  subHook: Address;
  subState: Address;
  /** Rent payer — must be the job's provider (programs enforce this). */
  payer: SolanaSigner;
  jobPda: Address;
  clientAddress: Address;
  providerAddress: Address;
  /** Pre-create the fund-request intent (kind 0) + its map. */
  fundRequestIntent: boolean;
  /** Pre-create the provider-escrow intent (kind 1) + its map. */
  escrowIntent: boolean;
  /** Pre-create the sub-hook proposed_terms PDA. */
  proposedTerms: boolean;
  /** When set, pre-create the sub_expiry PDA for this package id. */
  subExpiryPackageId: bigint | null;
};

/**
 * Build the pre-create instruction batch. Every instruction is top-level in
 * the caller's transaction, so each createAccount lands at CPI height 2.
 * Returns [] when nothing is requested.
 */
export async function buildPreCreateHookPdaIxs(
  args: PreCreateHookPdaArgs,
): Promise<SolanaInstructionLike[]> {
  // All three on-chain pre_create_* handlers hard-require payer == job.provider.
  // Refuse to build an instruction for the wrong party rather than emit one that
  // will revert on chain (or silently strand hook rent on the provider).
  if (args.payer.address !== args.providerAddress) {
    throw new Error(
      `pre_create_* requires the job provider as payer/signer (on-chain payer ` +
        `== job.provider). Got payer ${args.payer.address}, provider ` +
        `${args.providerAddress}.`,
    );
  }

  const ixs: SolanaInstructionLike[] = [];

  const intentKinds: (typeof INTENT_KIND_FUND_REQUEST | typeof INTENT_KIND_ESCROW)[] = [];
  if (args.fundRequestIntent) intentKinds.push(INTENT_KIND_FUND_REQUEST);
  if (args.escrowIntent) intentKinds.push(INTENT_KIND_ESCROW);

  if (intentKinds.length > 0 && !args.fundHook) {
    throw new Error("fundHook address is required to pre-create intent PDAs");
  }
  const fundHookState =
    intentKinds.length > 0 ? await hookStatePda(args.fundHook!) : null;
  for (const kind of intentKinds) {
    const fundHook = args.fundHook!;
    const intent = await intentPda(fundHook, args.jobPda, kind);
    const intentMap =
      kind === INTENT_KIND_FUND_REQUEST
        ? await fundRequestIntentIdPda(fundHook, args.jobPda)
        : await providerEscrowIntentIdPda(fundHook, args.jobPda);
    ixs.push(
      toLike(
        getPreCreateIntentInstruction(
          {
            payer: args.payer,
            hookState: fundHookState!,
            job: args.jobPda,
            intent,
            intentMap,
            jobKey: args.jobPda,
            kind,
          },
          { programAddress: fundHook },
        ),
      ),
    );
  }

  if (args.proposedTerms) {
    ixs.push(
      toLike(
        getPreCreateProposedTermsInstruction(
          {
            payer: args.payer,
            hookState: await hookStatePda(args.subHook),
            job: args.jobPda,
            proposedTerms: await proposedTermsPda(args.subHook, args.jobPda),
            jobKey: args.jobPda,
          },
          { programAddress: args.subHook },
        ),
      ),
    );
  }

  if (args.subExpiryPackageId !== null) {
    ixs.push(
      toLike(
        getPreCreateSubExpiryInstruction(
          {
            payer: args.payer,
            subscriptionExpiry: await subExpiryPda(
              args.subState,
              args.clientAddress,
              args.providerAddress,
              args.subExpiryPackageId,
            ),
            client: args.clientAddress,
            provider: args.providerAddress,
            packageId: args.subExpiryPackageId,
          },
          { programAddress: args.subState },
        ),
      ),
    );
  }

  return ixs;
}
