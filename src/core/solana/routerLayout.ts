/**
 * Multi-hook-router account layouts for the Solana ACP client.
 *
 * The router fans each job lifecycle action out to the sub-hooks configured
 * for that selector. On Solana the fan-out rides in the instruction itself:
 * after the ACP instruction's own accounts come
 *   [hook_router PDA, router_state PDA, instructions sysvar]   (router prefix)
 * and then, per configured sub-hook in fan-out order,
 *   [hook program, hook whitelist]  +  accountCount hook accounts,
 * where accountCount and the hook's own opt_params are declared in the
 * mode-0x01 multi-hook header carried as the ACP instruction's optParams
 * (encodeMultiHookHeader). The first account of every hook slice is the
 * hook's hook_state PDA (its BeforeAction/AfterAction named account); the
 * rest are its remaining accounts, always starting with the instructions
 * sysvar for CPI-caller validation.
 *
 * Slice shapes are pinned against the deployed programs:
 *   the subscription hook's before-action (pre_set_budget) and
 *   after-action (post_fund / post_complete / post_reject) handlers, and
 *   the multi-hook router's before-action framing.
 * Builders are pure: every on-chain read happens in the caller, results are
 * passed in, so orderings are unit-testable without an RPC.
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

/** Every job fan-out leg sets an explicit CU limit; two hook CPIs exceed the 200k default. */
export const ROUTER_CU_LIMIT = 1_400_000;

export function cuLimitIx(units: number = ROUTER_CU_LIMIT): SolanaInstructionLike {
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data };
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
 * any program is not deployed there (e.g. Solana mainnet, where the router,
 * subscription hook, and subscription state slots are empty).
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
 * [ACP whitelist PDA, self-declared hook_metadata PDA] pair for every UNIQUE
 * sub-hook, deduplicated in first-appearance order across the five selector
 * lists (setBudget, fund, submit, complete, reject) — the exact order the
 * router walks when it validates whitelists and caches metadata.
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
 * setBudget fan-out. The provider proposes subscription terms (sub-hook
 * pre_set_budget creates the proposed_terms PDA) and a fund request
 * (fund-hook post_set_budget stores the intent). Either half may be absent:
 * with no terms the sub slice is the minimal [hook_state, sysvar] no-op set,
 * with no fund request the fund slice is the minimal no-op set plus the job
 * account (the core's minimum-hook-accounts guard requires it whenever amount > 0).
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
 * fund fan-out. The client confirms the proposed terms (post_fund compares
 * its opt_params against the proposed_terms PDA) and the fund request
 * (fund-hook validates the confirmation against the stored intent and pays
 * the upfront). Confirmation params are always derived from on-chain state —
 * echoing the intent IS the client's consent to those exact terms.
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

  // post_fund remaining: [sysvar, proposed_terms]; the account is passed even
  // when no terms exist (the hook handles a nonexistent PDA, and a zero
  // duration in params then validates as "nothing confirmed").
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
    // PDA at remaining[1] so a client cannot skip a
    // live request by omitting it — the hook reads it and returns early when
    // unset or zero-sentinel. Omitting it fails IncompleteHookAccountSet (6019).
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
 * selector (the subscription hook declares SetBudget/Fund/Complete/Reject).
 * The provider bonds the escrow; with the "0x" no-escrow override the slice
 * is the minimal no-op set plus the job account (core minimum-hook-accounts guard).
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
 * into subscription-state, payer = provider. Pre-F-118, ActivateSubscription
 * declared payer as Signer because it allocated sub_expiry there; since
 * sub_expiry is now pre-created at set_budget, activation allocates nothing
 * and the provider's signature is no longer required. The fund hook releases
 * the escrow bond to the client.
 *
 * `requiredExtraSigner` is always null post-F-118 — kept as a return field so
 * a future signer requirement doesn't need a call-site shape change.
 */
export async function buildCompleteFanOut(
  ctx: RouterContext,
  p: {
    jobPda: Address;
    provider: Address;
    clientAddress: Address;
    /** packageId from the on-chain proposed_terms, or null when none exist. */
    packageId: bigint | null;
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

  let subSlice: AccountMetaLike[];
  if (p.packageId !== null) {
    // post_complete remaining: [sysvar, proposed_terms(w), payer(signer,w),
    // job, sub_state_program, writer_registry, subscription_expiry(w),
    // system]; hook_state precedes as the named account.
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
    ];
  } else {
    // No terms to consume, but post_complete still requires the canonical
    // proposed_terms PDA at remaining[1] so an evaluator
    // cannot skip activating a paid subscription by truncating the account
    // set — the hook no-ops when the PDA is unset. Omitting it fails
    // IncompleteHookAccountSet (6019).
    subSlice = [
      w(subHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ro(await mh.proposedTermsPda(ctx.subHook, p.jobPda)),
    ];
  }

  let fundSlice: AccountMetaLike[];
  if (p.escrow) {
    fundSlice = [
      w(fundHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ro(await mh.providerEscrowIntentIdPda(ctx.fundHook, p.jobPda)),
      w(await mh.intentPda(ctx.fundHook, p.jobPda, INTENT_KIND_ESCROW)),
      w(p.escrow.escrowVault),
      w(p.escrow.clientAta),
      ro(p.escrow.escrowAuthority),
      ro(TOKEN_PROGRAM_ID),
    ];
  } else {
    // No escrow to release, but auto_sign_escrow still requires the escrow-map
    // PDA at remaining[1] so a live escrow cannot
    // be skipped by omitting accounts — the hook no-ops when the map is unset.
    // Omitting it fails IncompleteHookAccountSet (6019).
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
// Identical to the router sub-hook slices minus the router prefix, framing
// pair, and multi-hook header: the ACP core CPIs the hook directly, so the
// slice is appended raw ([hook_state, ...remaining]) and opt_params carry the
// hook's own 16-byte terms encoding, not a header.
// ---------------------------------------------------------------------------

/**
 * setBudget: pre_set_budget proposes terms — remaining [sysvar, payer(signer),
 * proposed_terms(w), job, subscription_expiry, system] after hook_state.
 * Without terms the hook no-ops on empty opt_params; the minimal set plus the
 * job account satisfies the core's minimum-hook-accounts guard (amount > 0 on a hooked job).
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
 * Submit; the job account rides along for the core's minimum-hook-accounts guard.
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
 * subscription_expiry(w), system] after hook_state. Pre-F-118 the payer had
 * to SIGN (it allocated sub_expiry there); since sub_expiry is now
 * pre-created at set_budget, activation allocates nothing and no signature is
 * required. With no terms the minimal set no-ops.
 */
export async function buildSubCompleteAccounts(
  ctx: SubscriptionContext,
  p: {
    jobPda: Address;
    provider: Address;
    clientAddress: Address;
    /** packageId from the on-chain proposed_terms, or null when none exist. */
    packageId: bigint | null;
  }
): Promise<{ accounts: AccountMetaLike[]; requiredExtraSigner: Address | null }> {
  const hookState = await mh.hookStatePda(ctx.subHook);
  if (p.packageId === null) {
    // No terms to consume, but post_complete still requires the canonical
    // proposed_terms PDA at remaining[1] — present but
    // unset means "no-op", absent fails IncompleteHookAccountSet (6019).
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
    ],
    requiredExtraSigner: null,
  };
}

/**
 * reject: post_reject closes proposed_terms — remaining [sysvar,
 * proposed_terms(w), acp_state(ro), sponsor(w)]. The recipient must equal
 * acp_state.sponsor, matching close_proposed_terms/close_job_hook_accounts:
 * under gas sponsorship the provider's wallet holds only prefunded sponsor
 * lamports, so refunding it (the older "pays the proposing provider" design)
 * would let the provider farm the sponsor by proposing and rejecting in a
 * loop. The recipient does NOT sign, so reject stays a prepared builder. A
 * missing proposed_terms PDA still no-ops safely with this same account set
 * (post_reject returns before checking length once it sees the PDA unset).
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
  ];
}

/**
 * reject fan-out. The subscription hook closes the proposed_terms PDA and
 * refunds its rent to acp_state.sponsor — post_reject requires the recipient
 * writable but NOT as a signer, so reject stays a single-signer prepared
 * builder. The fund hook returns the escrow bond to the provider.
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
  // sponsor(w)]; hook_state precedes as the named account. Safe when no
  // terms exist — the hook no-ops on a missing proposed_terms PDA once it
  // sees the PDA unset, before checking this account count. See
  // buildSubRejectAccounts (the standalone equivalent) for why the recipient
  // is the sponsor, not the proposing provider.
  const subSlice: AccountMetaLike[] = [
    w(subHookState),
    ro(SYSVAR_INSTRUCTIONS_ID),
    w(await mh.proposedTermsPda(ctx.subHook, p.jobPda)),
    ro(await mh.acpStatePda(ctx.acp)),
    w(p.sponsor),
  ];

  let fundSlice: AccountMetaLike[];
  if (p.escrow) {
    fundSlice = [
      w(fundHookState),
      ro(SYSVAR_INSTRUCTIONS_ID),
      ro(await mh.providerEscrowIntentIdPda(ctx.fundHook, p.jobPda)),
      w(await mh.intentPda(ctx.fundHook, p.jobPda, INTENT_KIND_ESCROW)),
      w(p.escrow.escrowVault),
      w(p.escrow.providerAta),
      ro(p.escrow.escrowAuthority),
      ro(TOKEN_PROGRAM_ID),
    ];
  } else {
    // No escrow to return, but auto_sign_escrow still requires the escrow-map
    // PDA at remaining[1] so a live escrow cannot
    // be skipped by omitting accounts — the hook no-ops when the map is unset.
    // Omitting it fails IncompleteHookAccountSet (6019).
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
