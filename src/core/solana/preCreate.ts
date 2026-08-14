/**
 * Pre-creation of hook-rent PDAs at CPI stack height 2.
 *
 * A sponsor's rent prefund can miss account creations made deep in the CPI
 * stack. Router-mediated hook PDA creation (core -> router -> hook -> system)
 * sits at height 4, and sub_expiry activation (core -> [router ->] subHook ->
 * subState -> system) at height 4-5, so their rent would otherwise fall on the
 * provider wallet. The on-chain programs expose pre_create_* instructions that
 * allocate the same PDAs with a zero payload in a DIRECT transaction (height
 * 2), where the prefund sees them; the lifecycle handlers then accept the
 * pre-created accounts via their is_unset check and overwrite the full payload.
 *
 * All pre-creates are idempotent on-chain (no-op when the account already
 * holds data), payer MUST be the job's provider, and the job must already
 * exist (handlers deserialize it).
 *
 * This module is pure instruction-building so it can be unit-tested offline.
 * IMPORTANT: always the sync builder variants with an explicit
 * `programAddress` — the generated default program addresses are empty
 * strings for acp/fund-transfer-hook and the async variants derive PDAs from
 * those defaults.
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
  jobId: bigint;
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
    const intent = await intentPda(fundHook, args.jobId, kind);
    const intentMap =
      kind === INTENT_KIND_FUND_REQUEST
        ? await fundRequestIntentIdPda(fundHook, args.jobId)
        : await providerEscrowIntentIdPda(fundHook, args.jobId);
    ixs.push(
      toLike(
        getPreCreateIntentInstruction(
          {
            payer: args.payer,
            hookState: fundHookState!,
            job: args.jobPda,
            intent,
            intentMap,
            jobId: args.jobId,
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
            proposedTerms: await proposedTermsPda(args.subHook, args.jobId),
            jobId: args.jobId,
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
