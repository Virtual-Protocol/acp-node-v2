/**
 * Multi-hook-router account layouts for the Solana ACP client.
 *
 * The router fans each job lifecycle action out to the sub-hooks configured
 * for that selector, and on Solana the fan-out rides in the instruction:
 *   [hook_router PDA, router_state PDA, instructions sysvar]   (router prefix)
 * then, per sub-hook in fan-out order,
 *   [hook program, hook whitelist]  +  accountCount hook accounts,
 * with accountCount and each hook's opt_params declared in the mode-0x01
 * header carried as optParams (encodeMultiHookHeader). Each hook slice starts
 * with its hook_state PDA, then its remaining accounts, always beginning with
 * the instructions sysvar.
 *
 * Builders are pure: every on-chain read happens in the caller, so orderings
 * are unit-testable without an RPC.
 */
import { AccountRole, type Address } from "@solana/kit";
import type { SolanaInstructionLike } from "../../providers/types.js";
import {
  ACP_CONTRACT_ADDRESSES,
  FUND_TRANSFER_HOOK_ADDRESSES,
  MULTI_HOOK_ROUTER_ADDRESSES,
  SUBSCRIPTION_HOOK_ADDRESSES,
  SUBSCRIPTION_STATE_ADDRESSES,
  INTENT_KIND_FUND_REQUEST,
  INTENT_KIND_ESCROW,
} from "../constants.js";
import * as mh from "./multiHook.js";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111" as Address;
const SYSVAR_INSTRUCTIONS_ID =
  "Sysvar1nstructions1111111111111111111111111" as Address;
const TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111" as Address;

type AccountMetaLike = SolanaInstructionLike["accounts"][number];

const ro = (address: Address): AccountMetaLike => ({
  address,
  role: AccountRole.READONLY,
});
const w = (address: Address): AccountMetaLike => ({
  address,
  role: AccountRole.WRITABLE,
});
const ws = (address: Address): AccountMetaLike => ({
  address,
  role: AccountRole.WRITABLE_SIGNER,
});

export type SubscriptionTerms = { durationSecs: bigint; packageId: bigint };

export type FanOut = {
  /** Mode-0x01 multi-hook header to pass as the ACP instruction's optParams. */
  optParams: Uint8Array;
  /** Accounts to append after the ACP instruction's own accounts. */
  extraAccounts: AccountMetaLike[];
};

export type RouterContext = {
  chainId: number;
  acp: Address;
  router: Address;
  fundHook: Address;
  subHook: Address;
  subState: Address;
};

/**
 * The per-transaction compute ceiling. Used as the RETRY TARGET only: Solana
 * charges the REQUESTED limit against each writable account's per-block budget,
 * so declaring the ceiling up front spends capacity nothing will use.
 */
export const ROUTER_CU_LIMIT = 1_400_000;

/**
 * The FALLBACK limit, for a leg whose consumption could not be measured —
 * sizing must never cost a caller their send, so the sizer fails open onto
 * this rather than onto the ceiling.
 *
 * Above the runtime's 200k-per-instruction default, because the fan-out runs
 * two hook CPIs inside one instruction. Deliberately generous: an unmeasured
 * leg has no evidence behind it, and only the ceiling retry sits under it.
 */
export const ROUTER_CU_DEFAULT = 400_000;

/**
 * Headroom over measured consumption, and the floor a sized limit never goes
 * under. Matches the margin the server-side sizers use, so a limit means the
 * same thing wherever it was authored.
 */
export const CU_LIMIT_HEADROOM = 1.1;
export const CU_LIMIT_FLOOR = 60_000;

/**
 * The headroom a compute-exhaustion RETRY sizes with. Wider than the standard
 * margin, which already proved too small once; this is the last attempt, so it
 * re-measures and leaves room for the same drift to recur.
 */
export const BUMP_CU_HEADROOM = 1.5;

/**
 * The sized limit for a measured consumption, clamped to the ceiling so
 * headroom can never encode a limit the runtime rejects.
 */
export function sizedCuLimit(
  unitsConsumed: number,
  headroom: number = CU_LIMIT_HEADROOM,
): number {
  return Math.min(
    Math.max(Math.ceil(unitsConsumed * headroom), CU_LIMIT_FLOOR),
    ROUTER_CU_LIMIT,
  );
}

export function cuLimitIx(units: number = ROUTER_CU_DEFAULT): SolanaInstructionLike {
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data };
}

/** A SetComputeUnitLimit (tag 2), as opposed to any other ComputeBudget ix. */
function isSetComputeUnitLimitIx(ix: SolanaInstructionLike): boolean {
  return (
    (ix.programAddress as string) === COMPUTE_BUDGET_PROGRAM_ID &&
    ix.data.length === 5 &&
    ix.data[0] === 2
  );
}

/**
 * The same instruction list carrying `units` as its compute limit. Only tag 2
 * is replaced, and it is re-authored at the FRONT where call sites place it.
 */
export function withCuLimit(
  instructions: SolanaInstructionLike[],
  units: number,
): SolanaInstructionLike[] {
  return [
    cuLimitIx(units),
    ...instructions.filter((ix) => !isSetComputeUnitLimitIx(ix)),
  ];
}

/** The same instruction list with its compute limit raised to the ceiling. */
export function withMaxCuLimit(
  instructions: SolanaInstructionLike[],
): SolanaInstructionLike[] {
  return withCuLimit(instructions, ROUTER_CU_LIMIT);
}

/** True when the job's hookAddress is the multi-hook router on this chain. */
export function isRouterHook(chainId: number, hookAddress: string): boolean {
  const router = MULTI_HOOK_ROUTER_ADDRESSES[chainId];
  return !!router && router === hookAddress;
}

/** True when the job's hookAddress is the subscription hook itself (standalone). */
export function isSubscriptionHook(
  chainId: number,
  hookAddress: string
): boolean {
  const subHook = SUBSCRIPTION_HOOK_ADDRESSES[chainId];
  return !!subHook && subHook === hookAddress;
}

export type SubscriptionContext = {
  chainId: number;
  acp: Address;
  subHook: Address;
  subState: Address;
};

/**
 * Resolve the programs a STANDALONE subscription-hook job needs (no router,
 * no fund hook). Throws when they are not deployed on the chain.
 */
export function subscriptionContext(chainId: number): SubscriptionContext {
  const acp = ACP_CONTRACT_ADDRESSES[chainId];
  const subHook = SUBSCRIPTION_HOOK_ADDRESSES[chainId];
  const subState = SUBSCRIPTION_STATE_ADDRESSES[chainId];
  if (!acp || !subHook || !subState) {
    throw new Error(
      `Subscription hook flow is not available on chain ${chainId}: ` +
        `subscription programs are not deployed there.`
    );
  }
  return {
    chainId,
    acp: acp as Address,
    subHook: subHook as Address,
    subState: subState as Address,
  };
}

/**
 * Resolve the full program set the router flow needs on a chain. Throws when
 * any program is not deployed there.
 */
export function routerContext(chainId: number): RouterContext {
  const acp = ACP_CONTRACT_ADDRESSES[chainId];
  const router = MULTI_HOOK_ROUTER_ADDRESSES[chainId];
  const fundHook = FUND_TRANSFER_HOOK_ADDRESSES[chainId];
  const subHook = SUBSCRIPTION_HOOK_ADDRESSES[chainId];
  const subState = SUBSCRIPTION_STATE_ADDRESSES[chainId];
  if (!acp || !router || !fundHook || !subHook || !subState) {
    throw new Error(
      `Multi-hook router flow is not available on chain ${chainId}: ` +
        `router/subscription programs are not deployed there.`
    );
  }
  return {
    chainId,
    acp: acp as Address,
    router: router as Address,
    fundHook: fundHook as Address,
    subHook: subHook as Address,
    subState: subState as Address,
  };
}

/**
 * Router prefix appended on every lifecycle leg (and on createJob):
 * the per-job hook_router PDA, the router_state PDA, and the instructions
 * sysvar the router uses to validate it is being called by the ACP program.
 */
export async function routerPrefixAccounts(
  ctx: RouterContext,
  job: Address
): Promise<AccountMetaLike[]> {
  return [
    ro(await mh.hookRouterPda(ctx.router, job)),
    ro(await mh.routerStatePda(ctx.router)),
    ro(SYSVAR_INSTRUCTIONS_ID),
  ];
}

/**
 * Accounts batchConfigureHooks needs beyond the generated instruction: an
 * [ACP whitelist PDA, hook_metadata PDA] pair per UNIQUE sub-hook, in
 * first-appearance order across the five selector lists — the order the router
 * walks them in.
 */
export async function batchConfigureHooksExtraAccounts(
  acp: Address,
  selectorLists: Address[][]
): Promise<AccountMetaLike[]> {
  const unique: Address[] = [];
  for (const list of selectorLists) {
    for (const hook of list) {
      if (!unique.includes(hook)) unique.push(hook);
    }
  }
  const accounts: AccountMetaLike[] = [];
  for (const hook of unique) {
    accounts.push(
      ro(await mh.hookWhitelistPda(acp, hook)),
      ro(await mh.hookMetadataPda(hook))
    );
  }
  return accounts;
}

/**
 * The standard sub-hook layout this SDK configures for router jobs:
 * setBudget/fund/complete/reject fan out to [subscription hook, fund hook];
 * submit to [fund hook] only (the subscription hook does not implement the
 * Submit selector). Mirrors the EVM buildSubscriptionWithFundsHookConfig.
 */
export function standardHookLists(ctx: RouterContext): {
  setBudget: Address[];
  fund: Address[];
  submit: Address[];
  complete: Address[];
  reject: Address[];
} {
  const both = [ctx.subHook, ctx.fundHook];
  return {
    setBudget: both,
    fund: both,
    submit: [ctx.fundHook],
    complete: both,
    reject: both,
  };
}

/** Framing for one sub-hook block: [hook program, hook whitelist]. */
async function hookFraming(
  ctx: RouterContext,
  hook: Address
): Promise<AccountMetaLike[]> {
  return [ro(hook), ro(await mh.hookWhitelistPda(ctx.acp, hook))];
}

/**
 * setBudget fan-out. The provider proposes subscription terms and a fund
 * request; either half may be absent, in which case that slice is the minimal
 * [hook_state, sysvar] no-op set — plus the job account on the fund side
 * whenever amount > 0.
 */
export async function buildSetBudgetFanOut(
  ctx: RouterContext,
  p: {
    jobPda: Address;
    /** The provider signing setBudget; pays proposed_terms rent. */
    seller: Address;
    clientAddress: Address;
    terms: SubscriptionTerms | null;
    /** Fund-request proposal bytes ([token 32][amount u64][recipient 32]) or null. */
    fundRequestParams: Uint8Array | null;
  }
): Promise<FanOut> {
  const subHookState = await mh.hookStatePda(ctx.subHook);
  const fundHookState = await mh.hookStatePda(ctx.fundHook);

  let subSlice: AccountMetaLike[];
  let subParams: Uint8Array;
  if (p.terms) {
    // pre_set_budget remaining: [sysvar, payer(signer,w), proposed_terms(w),
    // job, subscription_expiry, system]; hook_state precedes as the named account.
    subSlice = [
      w(subHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ws(p.seller),
      w(await mh.proposedTermsPda(ctx.subHook, p.jobPda)),
      ro(p.jobPda),
      ro(
        await mh.subExpiryPda(
          ctx.subState,
          p.clientAddress,
          p.seller,
          p.terms.packageId
        )
      ),
      ro(SYSTEM_PROGRAM_ID),
    ];
    subParams = mh.encodeSubParams(p.terms.durationSecs, p.terms.packageId);
  } else {
    subSlice = [w(subHookState), ro(SYSVAR_INSTRUCTIONS_ID)];
    subParams = new Uint8Array(0);
  }

  let fundSlice: AccountMetaLike[];
  if (p.fundRequestParams && p.fundRequestParams.length > 0) {
    fundSlice = [
      w(fundHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ws(p.seller),
      w(await mh.intentPda(ctx.fundHook, p.jobPda, INTENT_KIND_FUND_REQUEST)),
      w(await mh.fundRequestIntentIdPda(ctx.fundHook, p.jobPda)),
      ro(p.jobPda),
      ro(SYSTEM_PROGRAM_ID),
    ];
  } else {
    fundSlice = [w(fundHookState), ro(SYSVAR_INSTRUCTIONS_ID), ro(p.jobPda)];
  }

  return {
    optParams: mh.encodeMultiHookHeader([
      { accountCount: subSlice.length, params: subParams },
      {
        accountCount: fundSlice.length,
        params: p.fundRequestParams ?? new Uint8Array(0),
      },
    ]),
    extraAccounts: [
      ...(await routerPrefixAccounts(ctx, p.jobPda)),
      ...(await hookFraming(ctx, ctx.subHook)),
      ...subSlice,
      ...(await hookFraming(ctx, ctx.fundHook)),
      ...fundSlice,
    ],
  };
}

/**
 * fund fan-out. The client confirms the proposed terms and the fund request,
 * with confirmation params always derived from on-chain state.
 */
export async function buildFundFanOut(
  ctx: RouterContext,
  p: {
    jobPda: Address;
    proposedTerms: { duration: bigint; packageId: bigint } | null;
    fundIntent: {
      token: Address;
      amount: bigint;
      recipient: Address;
      /** Source token account (intent.from's ATA in intent.token). */
      fromAta: Address;
      /** Destination token account (intent.recipient's ATA in intent.token). */
      recipientAta: Address;
    } | null;
  }
): Promise<FanOut> {
  const subHookState = await mh.hookStatePda(ctx.subHook);
  const fundHookState = await mh.hookStatePda(ctx.fundHook);

  // post_fund remaining: [sysvar, proposed_terms]. Passed even when no terms
  // exist; a zero duration then validates as "nothing confirmed".
  const subSlice: AccountMetaLike[] = [
    w(subHookState),
    ro(SYSVAR_INSTRUCTIONS_ID),
    ro(await mh.proposedTermsPda(ctx.subHook, p.jobPda)),
  ];
  const subParams = p.proposedTerms
    ? mh.encodeSubParams(p.proposedTerms.duration, p.proposedTerms.packageId)
    : new Uint8Array(0);

  let fundSlice: AccountMetaLike[];
  let fundParams: Uint8Array;
  if (p.fundIntent) {
    fundSlice = [
      w(fundHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ro(await mh.fundRequestIntentIdPda(ctx.fundHook, p.jobPda)),
      w(await mh.intentPda(ctx.fundHook, p.jobPda, INTENT_KIND_FUND_REQUEST)),
      w(p.fundIntent.fromAta),
      w(p.fundIntent.recipientAta),
      ro(TOKEN_PROGRAM_ID),
    ];
    fundParams = mh.encodeFundConfirmation(
      p.fundIntent.token,
      p.fundIntent.amount,
      p.fundIntent.recipient
    );
  } else {
    // No live fund request, but post_fund still requires the fund-request map
    // PDA at remaining[1]; the hook returns early when it is unset.
    fundSlice = [
      w(fundHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ro(await mh.fundRequestIntentIdPda(ctx.fundHook, p.jobPda)),
    ];
    fundParams = new Uint8Array(0);
  }

  return {
    optParams: mh.encodeMultiHookHeader([
      { accountCount: subSlice.length, params: subParams },
      { accountCount: fundSlice.length, params: fundParams },
    ]),
    extraAccounts: [
      ...(await routerPrefixAccounts(ctx, p.jobPda)),
      ...(await hookFraming(ctx, ctx.subHook)),
      ...subSlice,
      ...(await hookFraming(ctx, ctx.fundHook)),
      ...fundSlice,
    ],
  };
}

/**
 * submit fan-out. Only the fund-transfer hook is configured on the Submit
 * selector. The provider bonds the escrow; with the "0x" no-escrow override
 * the slice is the minimal no-op set plus the job account.
 */
export async function buildSubmitFanOut(
  ctx: RouterContext,
  p: {
    jobPda: Address;
    seller: Address;
    escrow: {
      token: Address;
      amount: bigint;
      /** The provider's token account for the escrow mint. */
      providerAta: Address;
      escrowVault: Address;
      escrowAuthority: Address;
    } | null;
  }
): Promise<FanOut> {
  const fundHookState = await mh.hookStatePda(ctx.fundHook);

  let fundSlice: AccountMetaLike[];
  let fundParams: Uint8Array;
  if (p.escrow) {
    // post_submit remaining: [sysvar, payer, intent, map, provider_token,
    // escrow_vault, escrow_authority, token_program, system_program, job];
    // hook_state precedes as the named account.
    fundSlice = [
      w(fundHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ws(p.seller),
      w(await mh.intentPda(ctx.fundHook, p.jobPda, INTENT_KIND_ESCROW)),
      w(await mh.providerEscrowIntentIdPda(ctx.fundHook, p.jobPda)),
      w(p.escrow.providerAta),
      w(p.escrow.escrowVault),
      ro(p.escrow.escrowAuthority),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
      ro(p.jobPda),
    ];
    fundParams = mh.encodeEscrowProposal(p.escrow.token, p.escrow.amount);
  } else {
    fundSlice = [w(fundHookState), ro(SYSVAR_INSTRUCTIONS_ID), ro(p.jobPda)];
    fundParams = new Uint8Array(0);
  }

  return {
    optParams: mh.encodeMultiHookHeader([
      { accountCount: fundSlice.length, params: fundParams },
    ]),
    extraAccounts: [
      ...(await routerPrefixAccounts(ctx, p.jobPda)),
      ...(await hookFraming(ctx, ctx.fundHook)),
      ...fundSlice,
    ],
  };
}

/**
 * complete fan-out. The subscription hook activates the subscription via CPI
 * into subscription-state; sub_expiry is pre-created at set_budget, so
 * activation allocates nothing and needs no provider signature. The fund hook
 * releases the escrow bond to the client.
 *
 * `requiredExtraSigner` is always null — kept as a return field so a future
 * signer requirement needs no call-site shape change.
 */
export async function buildCompleteFanOut(
  ctx: RouterContext,
  p: {
    jobPda: Address;
    provider: Address;
    clientAddress: Address;
    /** packageId from the on-chain proposed_terms, or null when none exist. */
    packageId: bigint | null;
    /** proposed_terms / escrow-intent rent refund recipient; must equal
     * acp_state.sponsor, which both hooks re-read and check. */
    sponsor: Address;
    escrow: {
      /** Escrow release destination (the client's ATA in the escrow mint). */
      clientAta: Address;
      escrowVault: Address;
      escrowAuthority: Address;
    } | null;
  }
): Promise<FanOut & { requiredExtraSigner: Address | null }> {
  const subHookState = await mh.hookStatePda(ctx.subHook);
  const fundHookState = await mh.hookStatePda(ctx.fundHook);
  const acpState = await mh.acpStatePda(ctx.acp);

  let subSlice: AccountMetaLike[];
  if (p.packageId !== null) {
    // post_complete remaining: [sysvar, proposed_terms(w), payer(signer,w),
    // job, sub_state_program, writer_registry, subscription_expiry(w),
    // system, acp_state(ro), sponsor(w)]; hook_state precedes as the named
    // account.
    //
    // The acp_state/sponsor tail is required, not padding: post_complete
    // refunds the closed proposed_terms rent to acp_state.sponsor and takes
    // `remaining.len() >= 10` as its completeness signal.
    subSlice = [
      w(subHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      w(await mh.proposedTermsPda(ctx.subHook, p.jobPda)),
      w(p.provider),
      ro(p.jobPda),
      ro(ctx.subState),
      ro(await mh.writerRegistryPda(ctx.subState, ctx.subHook)),
      w(
        await mh.subExpiryPda(
          ctx.subState,
          p.clientAddress,
          p.provider,
          p.packageId
        )
      ),
      ro(SYSTEM_PROGRAM_ID),
      ro(acpState),
      w(p.sponsor),
    ];
  } else {
    // No terms to consume, but post_complete still requires the canonical
    // proposed_terms PDA at remaining[1]; the hook no-ops when it is unset.
    subSlice = [
      w(subHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ro(await mh.proposedTermsPda(ctx.subHook, p.jobPda)),
    ];
  }

  let fundSlice: AccountMetaLike[];
  if (p.escrow) {
    // auto_sign_escrow remaining: [sysvar, escrow_map, intent(w), vault(w),
    // dest(w), escrow_authority, token_program, acp_state(ro), sponsor(w),
    // job(ro)]; hook_state precedes as the named account. Same acp_state/
    // sponsor tail as post_complete, for the escrow vault's rent.
    fundSlice = [
      w(fundHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ro(await mh.providerEscrowIntentIdPda(ctx.fundHook, p.jobPda)),
      w(await mh.intentPda(ctx.fundHook, p.jobPda, INTENT_KIND_ESCROW)),
      w(p.escrow.escrowVault),
      w(p.escrow.clientAta),
      ro(p.escrow.escrowAuthority),
      ro(TOKEN_PROGRAM_ID),
      ro(acpState),
      w(p.sponsor),
      // job, read only for shard_index: rent returns to the shard that
      // prefunded it.
      ro(p.jobPda),
    ];
  } else {
    // No escrow to release, but auto_sign_escrow still requires the escrow-map
    // PDA at remaining[1]; the hook no-ops when the map is unset.
    fundSlice = [
      w(fundHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ro(await mh.providerEscrowIntentIdPda(ctx.fundHook, p.jobPda)),
    ];
  }

  return {
    optParams: mh.encodeMultiHookHeader([
      { accountCount: subSlice.length, params: new Uint8Array(0) },
      { accountCount: fundSlice.length, params: new Uint8Array(0) },
    ]),
    extraAccounts: [
      ...(await routerPrefixAccounts(ctx, p.jobPda)),
      ...(await hookFraming(ctx, ctx.subHook)),
      ...subSlice,
      ...(await hookFraming(ctx, ctx.fundHook)),
      ...fundSlice,
    ],
    requiredExtraSigner: null,
  };
}

// ---------------------------------------------------------------------------
// Standalone subscription-hook slices (job's hookAddress IS the sub hook).
// The router sub-hook slices minus the prefix, framing pair, and header: the
// core CPIs the hook directly, so the slice is appended raw and opt_params
// carry the hook's own 16-byte terms encoding.
// ---------------------------------------------------------------------------

/**
 * setBudget: pre_set_budget proposes terms — remaining [sysvar, payer(signer),
 * proposed_terms(w), job, subscription_expiry, system] after hook_state.
 * Without terms the hook no-ops on empty opt_params.
 */
export async function buildSubSetBudgetAccounts(
  ctx: SubscriptionContext,
  p: {
    jobPda: Address;
    seller: Address;
    clientAddress: Address;
    terms: SubscriptionTerms | null;
  }
): Promise<AccountMetaLike[]> {
  const hookState = await mh.hookStatePda(ctx.subHook);
  if (!p.terms) {
    return [w(hookState), ro(SYSVAR_INSTRUCTIONS_ID), ro(p.jobPda)];
  }
  return [
    w(hookState),
    ro(SYSVAR_INSTRUCTIONS_ID),
    ws(p.seller),
    w(await mh.proposedTermsPda(ctx.subHook, p.jobPda)),
    ro(p.jobPda),
    ro(
      await mh.subExpiryPda(
        ctx.subState,
        p.clientAddress,
        p.seller,
        p.terms.packageId
      )
    ),
    ro(SYSTEM_PROGRAM_ID),
  ];
}

/** fund: post_fund validates the client's terms echo — remaining [sysvar, proposed_terms]. */
export async function buildSubFundAccounts(
  ctx: SubscriptionContext,
  job: Address
): Promise<AccountMetaLike[]> {
  return [
    w(await mh.hookStatePda(ctx.subHook)),
    ro(SYSVAR_INSTRUCTIONS_ID),
    ro(await mh.proposedTermsPda(ctx.subHook, job)),
  ];
}

/**
 * submit (with evaluator): the sub hook validates the caller and no-ops on
 * Submit; the job account rides along for the core's account-count guard.
 */
export async function buildSubSubmitAccounts(
  ctx: SubscriptionContext,
  jobPda: Address
): Promise<AccountMetaLike[]> {
  return [
    w(await mh.hookStatePda(ctx.subHook)),
    ro(SYSVAR_INSTRUCTIONS_ID),
    ro(jobPda),
  ];
}

/**
 * complete: post_complete activates the subscription — remaining [sysvar,
 * proposed_terms(w), payer(w), job, sub_state_program, writer_registry,
 * subscription_expiry(w), system] after hook_state. sub_expiry is pre-created
 * at set_budget, so activation allocates nothing and needs no signature. With
 * no terms the minimal set no-ops.
 */
export async function buildSubCompleteAccounts(
  ctx: SubscriptionContext,
  p: {
    jobPda: Address;
    provider: Address;
    clientAddress: Address;
    /** packageId from the on-chain proposed_terms, or null when none exist. */
    packageId: bigint | null;
    /** proposed_terms rent refund recipient; must equal acp_state.sponsor. */
    sponsor: Address;
  }
): Promise<{ accounts: AccountMetaLike[]; requiredExtraSigner: Address | null }> {
  const hookState = await mh.hookStatePda(ctx.subHook);
  if (p.packageId === null) {
    // No terms to consume, but post_complete still requires the canonical
    // proposed_terms PDA at remaining[1]; unset means "no-op".
    return {
      accounts: [
        w(hookState),
        ro(SYSVAR_INSTRUCTIONS_ID),
        ro(await mh.proposedTermsPda(ctx.subHook, p.jobPda)),
      ],
      requiredExtraSigner: null,
    };
  }
  return {
    accounts: [
      w(hookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      w(await mh.proposedTermsPda(ctx.subHook, p.jobPda)),
      w(p.provider),
      ro(p.jobPda),
      ro(ctx.subState),
      ro(await mh.writerRegistryPda(ctx.subState, ctx.subHook)),
      w(
        await mh.subExpiryPda(
          ctx.subState,
          p.clientAddress,
          p.provider,
          p.packageId
        )
      ),
      ro(SYSTEM_PROGRAM_ID),
      // Same acp_state/sponsor rent-refund tail the router path sends:
      // post_complete is the same handler with the same completeness gate.
      ro(await mh.acpStatePda(ctx.acp)),
      w(p.sponsor),
    ],
    requiredExtraSigner: null,
  };
}

/**
 * reject: post_reject closes proposed_terms — remaining [sysvar,
 * proposed_terms(w), acp_state(ro), sponsor(w)]. The recipient must equal
 * acp_state.sponsor, matching close_proposed_terms/close_job_hook_accounts.
 * The recipient does NOT sign, so reject stays a prepared builder. A missing
 * proposed_terms PDA still no-ops safely with this same account set.
 */
export async function buildSubRejectAccounts(
  ctx: SubscriptionContext,
  p: { jobPda: Address; sponsor: Address }
): Promise<AccountMetaLike[]> {
  return [
    w(await mh.hookStatePda(ctx.subHook)),
    ro(SYSVAR_INSTRUCTIONS_ID),
    w(await mh.proposedTermsPda(ctx.subHook, p.jobPda)),
    ro(await mh.acpStatePda(ctx.acp)),
    w(p.sponsor),
    // job, read only for shard_index: rent returns to the shard that
    // prefunded it.
    ro(p.jobPda),
  ];
}

/**
 * reject fan-out. The subscription hook closes proposed_terms and refunds its
 * rent to acp_state.sponsor, writable but not a signer, so reject stays a
 * single-signer prepared builder. The fund hook returns the bond to the
 * provider.
 */
export async function buildRejectFanOut(
  ctx: RouterContext,
  p: {
    jobPda: Address;
    /** proposed_terms rent refund recipient; must equal acp_state.sponsor. */
    sponsor: Address;
    escrow: {
      /** Escrow return destination (the provider's ATA in the escrow mint). */
      providerAta: Address;
      escrowVault: Address;
      escrowAuthority: Address;
    } | null;
  }
): Promise<FanOut> {
  const subHookState = await mh.hookStatePda(ctx.subHook);
  const fundHookState = await mh.hookStatePda(ctx.fundHook);

  // post_reject remaining: [sysvar, proposed_terms(w), acp_state(ro),
  // sponsor(w)]; hook_state precedes as the named account. Safe when no terms
  // exist — the hook no-ops on a missing proposed_terms PDA.
  const subSlice: AccountMetaLike[] = [
    w(subHookState),
    ro(SYSVAR_INSTRUCTIONS_ID),
    w(await mh.proposedTermsPda(ctx.subHook, p.jobPda)),
    ro(await mh.acpStatePda(ctx.acp)),
    w(p.sponsor),
    // job, read only for shard_index: the rent must return to the shard
    // that prefunded it, not to any live shard.
    ro(p.jobPda),
  ];

  let fundSlice: AccountMetaLike[];
  if (p.escrow) {
    // auto_sign_escrow remaining: [sysvar, escrow_map, intent(w), vault(w),
    // dest(w), escrow_authority, token_program, acp_state(ro), sponsor(w)].
    // Same handler as the complete path: reject and complete differ only in
    // the destination (provider vs client), not in the account set.
    fundSlice = [
      w(fundHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ro(await mh.providerEscrowIntentIdPda(ctx.fundHook, p.jobPda)),
      w(await mh.intentPda(ctx.fundHook, p.jobPda, INTENT_KIND_ESCROW)),
      w(p.escrow.escrowVault),
      w(p.escrow.providerAta),
      ro(p.escrow.escrowAuthority),
      ro(TOKEN_PROGRAM_ID),
      ro(await mh.acpStatePda(ctx.acp)),
      w(p.sponsor),
      // job, read only for shard_index: rent returns to the shard that
      // prefunded it.
      ro(p.jobPda),
    ];
  } else {
    // No escrow to return, but auto_sign_escrow still requires the escrow-map
    // PDA at remaining[1]; the hook no-ops when the map is unset.
    fundSlice = [
      w(fundHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ro(await mh.providerEscrowIntentIdPda(ctx.fundHook, p.jobPda)),
    ];
  }

  return {
    optParams: mh.encodeMultiHookHeader([
      { accountCount: subSlice.length, params: new Uint8Array(0) },
      { accountCount: fundSlice.length, params: new Uint8Array(0) },
    ]),
    extraAccounts: [
      ...(await routerPrefixAccounts(ctx, p.jobPda)),
      ...(await hookFraming(ctx, ctx.subHook)),
      ...subSlice,
      ...(await hookFraming(ctx, ctx.fundHook)),
      ...fundSlice,
    ],
  };
}
