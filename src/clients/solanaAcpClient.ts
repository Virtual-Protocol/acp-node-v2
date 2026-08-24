import {
  type Address,
  type Signature,
  AccountRole,
  getProgramDerivedAddress,
  getAddressDecoder,
  getAddressEncoder,
  getU64Decoder,
  getU64Encoder,
  getUtf8Encoder,
} from "@solana/kit";
import { hexToBytes } from "viem";
import {
  decodeSolanaEscrowOptParams,
  encodeFundTransferFundOptParams,
  encodeFundTransferSubmitOptParams,
} from "../core/hookEncoding.js";
import {
  encodeDeliverableBytes,
  encodeReasonBytes,
} from "../core/solana/encoding.js";
import { buildPreCreateHookPdaIxs } from "../core/solana/preCreate.js";
import {
  encodeSubParams,
  decodeSubParams,
  fetchProposedTerms,
  fetchMaybeFundRequestIntentId,
  hookRouterPda,
  routerStatePda,
  subExpiryPda,
  writerRegistryPda,
  intentPda,
  proposedTermsPda,
} from "../core/solana/multiHook.js";
import {
  batchConfigureHooksExtraAccounts,
  buildCompleteFanOut,
  buildFundFanOut,
  buildRejectFanOut,
  buildSetBudgetFanOut,
  buildSubCompleteAccounts,
  buildSubFundAccounts,
  buildSubRejectAccounts,
  buildSubSetBudgetAccounts,
  buildSubSubmitAccounts,
  buildSubmitFanOut,
  cuLimitIx,
  isRouterHook,
  isSubscriptionHook,
  routerContext,
  routerPrefixAccounts,
  subscriptionContext,
} from "../core/solana/routerLayout.js";
import { createAndWarmLookupTable } from "../core/solana/lookupTable.js";
import { BaseAcpClient } from "./baseAcpClient.js";
import type {
  ApproveAllowanceParams,
  BatchConfigureHooksParams,
  CapabilityFlags,
  CompleteParams,
  CreateJobParams,
  FundParams,
  OnChainJob,
  PreparedSolanaTx,
  PreparedTxInput,
  RejectParams,
  SetBudgetParams,
  SubmitParams,
} from "../core/operations.js";
import type {
  ISolanaProviderAdapter,
  SendInstructionsOptions,
  SolanaInstructionLike,
  SolanaSigner,
} from "../providers/types.js";
import {
  JOB_CREATED_EVENT_DISC,
  ACP_COMMITMENT,
  ACP_SELECTORS,
  MULTI_HOOK_COMPLETE_ALT_ADDRESSES,
  MULTI_HOOK_ROUTER_ADDRESSES,
  SUBSCRIPTION_HOOK_ADDRESSES,
  EVM_NO_EVALUATOR_ADDRESS,
  SOLANA_NO_EVALUATOR_ADDRESS,
  INTENT_KIND_FUND_REQUEST,
  INTENT_KIND_ESCROW,
  SOLANA_CHAIN_ID_CLUSTERS,
} from "../core/constants.js";

import { buildJobStateRetryGuard } from "../core/solana/jobStateRetryGuard.js";
import {
  collectErrorText,
  decorateSendError,
  extractInstructionCustomCode,
} from "../core/solana/programErrors.js";
import { SolanaTransactionError } from "../providers/solana/txConfirmation.js";

// Codama-generated imports (direct file paths for Node v24 ESM compatibility)
import { fetchAcpState } from "../core/solana/generated/acp/accounts/acpState.js";
import { fetchMaybeSubscriptionExpiry } from "../core/solana/generated/subscription-state/accounts/subscriptionExpiry.js";
import { fetchJob } from "../core/solana/generated/acp/accounts/job.js";
import { getCreateJobInstructionAsync } from "../core/solana/generated/acp/instructions/createJob.js";
import { getSetBudgetInstruction } from "../core/solana/generated/acp/instructions/setBudget.js";
import { getFundInstruction } from "../core/solana/generated/acp/instructions/fund.js";
import { getSubmitInstructionAsync } from "../core/solana/generated/acp/instructions/submit.js";
import { getCompleteInstructionAsync } from "../core/solana/generated/acp/instructions/complete.js";
import { getRejectInstructionAsync } from "../core/solana/generated/acp/instructions/reject.js";
import { getBatchConfigureHooksInstructionAsync } from "../core/solana/generated/multi-hook-router/instructions/batchConfigureHooks.js";
import { getJobCreatedDecoder } from "../core/solana/generated/acp/types/jobCreated.js";
import { fetchMaybeProviderEscrowIntentId } from "../core/solana/generated/fund-transfer-hook/accounts/providerEscrowIntentId.js";
import { fetchIntent } from "../core/solana/generated/fund-transfer-hook/accounts/intent.js";

// JobState enum values (inlined to avoid Node v24 ESM enum transform issues)
const JOB_STATE_FUNDED = 1;
const JOB_STATE_SUBMITTED = 2;

const EMPTY_OPT_PARAMS = new Uint8Array(0);

// Fund-transfer hook InvalidJob (Anchor error 6000) — thrown when the intent
// PDA passed at prepare time no longer matches the hook's intent counter.
// No generated errors module exists for the hook, hence the local constant.
const HOOK_INVALID_JOB_CODE = 6000;

// Anchor framework ConstraintSeeds (2006). On CreateJob this means the job PDA
// the SDK derived is already taken — a collision on the client-chosen random
// u64 seed. Retrying re-runs createJob, which draws a fresh seed, so the retry
// is the correct recovery. The code is framework-generic (every Anchor account
// constraint emits it), so a 2006 is treated as stale ONLY when the logs also
// carry the CreateJob marker.
const ACP_CONSTRAINT_SEEDS_CODE = 2006;

// Marker strings (lowercased) identifying a CreateJob seed collision in
// sponsor-simulation error text. All three must be present: the sponsor prefix
// scopes it to a simulation failure (tx never broadcast, retry is safe), the
// instruction marker scopes it to CreateJob (other instructions derive the job
// PDA from a known client+seed pair — a 2006 there is a genuine bug, never
// retried).
const CREATE_JOB_SEEDS_RACE_MARKERS = [
  "alchemy_requestfeepayer failed",
  "instruction: createjob",
  "error code: constraintseeds",
];

// Marker strings (lowercased) identifying the create→configure sponsor-lag
// race: the router's BatchConfigureHooks takes the job as an UncheckedAccount,
// so a job the sponsor's simulation node has not seen yet fails the hook
// lib's owner check with InvalidJob (6000) instead of AccountNotInitialized.
// The sponsor prefix scopes it to a simulation failure (tx never broadcast,
// retry is safe); the instruction marker scopes it to BatchConfigureHooks so
// the fund hook's stale-intent InvalidJob keeps its own on-chain-log path.
// Outer shield behind the guarded fee-payer retry (see feePayerRetry.ts):
// this re-prepares and resends after the in-send retries exhaust.
const CONFIGURE_HOOKS_LAG_MARKERS = [
  "alchemy_requestfeepayer failed",
  "instruction: batchconfigurehooks",
  "error code: invalidjob.",
];

// Anchor framework AccountNotInitialized (3012). Fund/complete/reject bake
// intent-derived accounts at prepare time (fund-request intent, escrow
// intent); a concurrent setBudget/cancel closes that intent PDA, and the
// send fails 3012 at the hook's AfterAction (the E-H5 race). The same code
// also appears for plain sponsor lag (a PDA created moments ago not yet
// visible), which the in-send blind retry recovers — this constant powers
// the outer re-prepare for the race the blind retry cannot fix.
const ANCHOR_ACCOUNT_NOT_INITIALIZED_CODE = 3012;

// Marker groups (lowercased; every substring in a group must appear)
// identifying an AccountNotInitialized failure on a transaction that was
// provably never accepted by the cluster: rejected at the sponsor's
// simulation, or rejected at the broadcast node's preflight
// (formatPreflightFailure inlines the logs into a plain Error). Deliberately
// NOT instruction-scoped: a never-broadcast transaction makes re-prepare +
// resend always safe, and scoping would not reduce the only real cost —
// bounded slower surfacing of a deterministic 3012 bug (3 outer attempts).
// The name-with-period form pins the Anchor error name, not the number.
const ACCOUNT_NOT_INITIALIZED_STALE_MARKER_GROUPS: string[][] = [
  ["alchemy_requestfeepayer failed", "error code: accountnotinitialized."],
  ["transaction preflight failed", "error code: accountnotinitialized."],
];

const DEFAULT_PUBKEY = SOLANA_NO_EVALUATOR_ADDRESS as Address;

export class SolanaAcpClient extends BaseAcpClient<SolanaInstructionLike[]> {
  private readonly provider: ISolanaProviderAdapter;
  // Job PDAs are per-cluster (the same job id exists independently on devnet
  // and mainnet) AND per-client (jobId is a caller-chosen seed, unique only
  // within one client, not globally) — see jobPdaCacheKey.
  private jobPdaCache: Map<string, Address> = new Map();

  private constructor(
    contractAddresses: Record<number, string>,
    provider: ISolanaProviderAdapter
  ) {
    super(contractAddresses);
    this.provider = provider;
    if (Object.keys(contractAddresses).length === 0) {
      throw new Error("At least one contract address must be provided.");
    }
  }

  /** The ACP program deployed on the given chain (500 devnet, 501 mainnet). */
  private programAddress(chainId: number): Address {
    return this.getContractAddress(chainId) as Address;
  }

  static async create(input: {
    contractAddresses: Record<number, string>;
    provider: ISolanaProviderAdapter;
  }): Promise<SolanaAcpClient> {
    return new SolanaAcpClient(input.contractAddresses, input.provider);
  }

  getProvider(): ISolanaProviderAdapter {
    return this.provider;
  }

  override async getAddress(): Promise<string> {
    return this.provider.getAddress();
  }

  override getCapabilities(): CapabilityFlags {
    return {
      supportsBatch: true,
      supportsAllowance: false,
    };
  }

  async execute(
    chainId: number,
    instructions: SolanaInstructionLike[],
    extraOptions?: SendInstructionsOptions
  ): Promise<string | string[]> {
    // Lets sponsored adapters distinguish a WrongStatus caused by sponsor-node
    // simulation lag (retry) from a genuine one, e.g. an already-completed job
    // (fail fast). Non-sponsored adapters ignore it.
    // The router address gates BatchConfigureHooks the same way core
    // lifecycle instructions are gated (empty/missing on chains without a
    // router deployment — the guard then simply never matches router ixs).
    // The subscription hook's CleanupProposedTerms is gated the same way on
    // job.state (Expired), so a JobNotExpired from a lagging sponsor node is
    // recoverable while one on a live job is not.
    const routerAddress = MULTI_HOOK_ROUTER_ADDRESSES[chainId];
    const subHookAddress = SUBSCRIPTION_HOOK_ADDRESSES[chainId];
    const { guard, lastDiagnosis } = buildJobStateRetryGuard(
      this.provider.getRpc(chainId),
      this.programAddress(chainId),
      instructions,
      routerAddress ? (routerAddress as Address) : undefined,
      subHookAddress ? (subHookAddress as Address) : undefined
    );
    try {
      // extraOptions (e.g. a prepared reject's lookup table + sponsorship
      // flag) merge first; execute's own retry guard always wins.
      return await this.provider.sendInstructions(chainId, instructions, {
        ...extraOptions,
        retryGuard: guard,
      });
    } catch (err) {
      throw decorateSendError(err, lastDiagnosis());
    }
  }

  /**
   * Detects the stale-prepare classes, all safe to rebuild-and-resend
   * because the failed transaction provably had no on-chain effect:
   *
   * 1. Hook InvalidJob (error 6000) on a confirmed on-chain failure — the
   *    error older hook deployments throw when a prepared intent PDA goes
   *    stale before inclusion. The failed transaction is atomic, so nothing
   *    was applied. As a sponsor-simulation rejection it is recognized only
   *    under BatchConfigureHooks (the create→configure lag race).
   * 2. CreateJob ConstraintSeeds (Anchor 2006) — the job-counter race: the
   *    job PDA was derived from a counter snapshot that another createJob
   *    advanced before execution. Seen in two forms: a sponsor-simulation
   *    rejection (alchemy_requestFeePayer; tx never broadcast) or a
   *    confirmed on-chain failure (atomic revert).
   * 3. AccountNotInitialized (Anchor 3012) — the intent-close race (E-H5):
   *    fund/complete/reject bake intent-derived accounts at prepare, and a
   *    concurrent setBudget/cancel closes the intent PDA. Seen in three
   *    forms: sponsor-simulation rejection, broadcast preflight rejection
   *    ("Transaction preflight failed"), or a confirmed on-chain failure.
   *
   * Codes collide across programs (6000: ACP core Unauthorized, router
   * OnlyACPContract; 2006: any Anchor constraint), so verdicts are confirmed
   * against the transaction's own logs; an unreachable log fetch counts as
   * inconclusive and retries.
   */
  override async isStalePrepareError(
    chainId: number,
    err: unknown
  ): Promise<boolean> {
    // Sponsor-simulation form of a CreateJob seed collision: a plain Error
    // whose text (cause chain included) carries the requestFeePayer prefix
    // plus the CreateJob + ConstraintSeeds markers. Never broadcast, so a
    // re-prepare cannot double-create; it also draws a fresh seed.
    const text = collectErrorText(err).toLowerCase();
    if (CREATE_JOB_SEEDS_RACE_MARKERS.every((m) => text.includes(m))) {
      return true;
    }
    if (CONFIGURE_HOOKS_LAG_MARKERS.every((m) => text.includes(m))) {
      return true;
    }
    // AccountNotInitialized on a never-accepted transaction (sponsor
    // simulation or broadcast preflight): the prepared account set references
    // an intent PDA a concurrent transaction closed (E-H5) — rebuild from
    // fresh state. Nothing was broadcast, so a resend cannot double-apply.
    if (
      ACCOUNT_NOT_INITIALIZED_STALE_MARKER_GROUPS.some((group) =>
        group.every((m) => text.includes(m))
      )
    ) {
      return true;
    }

    if (!(err instanceof SolanaTransactionError) || err.phase !== "failed") {
      return false;
    }
    const code = extractInstructionCustomCode(err.txErr);
    if (
      code !== HOOK_INVALID_JOB_CODE &&
      code !== ACP_CONSTRAINT_SEEDS_CODE &&
      code !== ANCHOR_ACCOUNT_NOT_INITIALIZED_CODE
    ) {
      return false;
    }
    try {
      const tx = await this.provider
        .getRpc(chainId)
        .getTransaction(err.signature as Signature, {
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        })
        .send();
      const logs = tx?.meta?.logMessages;
      if (!logs) return true;
      if (code === HOOK_INVALID_JOB_CODE) {
        return logs.some((log) => log.includes("Error Code: InvalidJob"));
      }
      // AccountNotInitialized: an on-chain failure is an atomic revert, so a
      // re-prepare from fresh state is safe. The name check disambiguates
      // other programs' numeric 3012 collisions, mirroring the 6000 handling.
      if (code === ANCHOR_ACCOUNT_NOT_INITIALIZED_CODE) {
        return logs.some((log) =>
          log.includes("Error Code: AccountNotInitialized")
        );
      }
      // ConstraintSeeds: stale only when it is the createJob counter race —
      // require the CreateJob instruction marker alongside the error name.
      return (
        logs.some((log) => log.includes("Instruction: CreateJob")) &&
        logs.some((log) => log.includes("Error Code: ConstraintSeeds"))
      );
    } catch {
      return true;
    }
  }

  override async submitPrepared(
    chainId: number,
    prepared: PreparedTxInput
  ): Promise<string | string[]> {
    const instructions: SolanaInstructionLike[] = [];
    let sendOptions: SendInstructionsOptions | undefined;

    for (const item of prepared) {
      if (item.chain !== "solana") {
        throw new Error(
          `Prepared transaction chain mismatch: expected "solana" but received "${item.chain}".`
        );
      }
      instructions.push(...item.tx);
      if (item.sendOptions) {
        sendOptions = { ...sendOptions, ...item.sendOptions };
      }
    }

    return this.execute(chainId, instructions, sendOptions);
  }

  override async createJob(
    chainId: number,
    params: CreateJobParams
  ): Promise<PreparedSolanaTx> {
    const signer = this.provider.getSigner();

    // The job's identity is its own account address, derived from
    // ["job", client, seed] — `seed` is a caller-chosen u64 uniquifier, not a
    // re-usable identifier, and need only be unique per client (the program's
    // `init` rejects a reuse by the same client). A random value is therefore
    // both sufficient and race-free: unlike the old acp_state.job_counter + 1
    // scheme, two concurrent createJob calls (even from the same client) no
    // longer contend on one shared counter and cannot collide with each other
    // by racing a read.
    const seedBytes = new Uint8Array(8);
    crypto.getRandomValues(seedBytes);
    const seed = getU64Decoder().decode(seedBytes);

    const acpStatePda = await this.deriveAcpStatePda(chainId);
    const jobPda = await this.deriveJobPda(chainId, signer.address, seed);

    let hookWhitelist: Address | undefined;
    if (params.hookAddress) {
      hookWhitelist = await this.deriveHookWhitelistPda(chainId, 
        params.hookAddress as Address
      );
    }

    // Chain-agnostic callers (e.g. AcpAgent) express "no evaluator" as the
    // EVM zero address, which is not valid base58 and would fail encoding.
    // Map it (and an absent value) to the on-chain sentinel.
    const evaluator =
      !params.evaluatorAddress ||
      params.evaluatorAddress.toLowerCase() === EVM_NO_EVALUATOR_ADDRESS
        ? DEFAULT_PUBKEY
        : (params.evaluatorAddress as Address);

    const ix = await getCreateJobInstructionAsync(
      {
        client: signer,
        job: jobPda,
        acpState: acpStatePda,
        seed,
        provider: params.providerAddress as Address,
        evaluator,
        description: params.description,
        expiredAt: params.expiredAt,
        hookAddress: params.hookAddress
          ? (params.hookAddress as Address)
          : null,
        ...(hookWhitelist ? { hookWhitelist } : {}),
      },
      { programAddress: this.programAddress(chainId) }
    );

    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    if (params.hookAddress && isRouterHook(chainId, params.hookAddress)) {
      // The router has no hook_state PDA; it validates through its per-job
      // hook_router PDA, router_state, and the instructions sysvar.
      extraAccounts.push(
        ...(await routerPrefixAccounts(routerContext(chainId), jobPda))
      );
    } else if (params.hookAddress) {
      const hookStatePda = await this.deriveHookStatePda(
        params.hookAddress as Address
      );
      extraAccounts.push({ address: hookStatePda, role: AccountRole.READONLY });
    }

    this.jobPdaCache.set(this.jobPdaCacheKey(chainId, signer.address, seed), jobPda);

    return this.wrapMany(chainId, [
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
  }

  override async setBudget(
    chainId: number,
    params: SetBudgetParams
  ): Promise<PreparedSolanaTx> {
    const rpc = this.provider.getRpc(chainId);
    const signer = this.provider.getSigner();
    const jobPda = await this.resolveJobPda(chainId, params.jobId, params.clientAddress);
    const job = await fetchJob(rpc, jobPda, { commitment: ACP_COMMITMENT });

    // No vault exists yet at setBudget time (fund() creates it), and
    // budget_mint no longer exists on Job — the payment mint is the single
    // global acp_state.payment_token, checked against a caller's choice only
    // at fund, not stored per-job.
    const acpStatePda = await this.deriveAcpStatePda(chainId);
    const acpState = await fetchAcpState(rpc, acpStatePda, { commitment: ACP_COMMITMENT });
    const mintAddress = acpState.data.paymentToken;

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    // The hook decodes the fund-request proposal from opt_params
    // ([token 32][amount u64 LE 8][destination 32]). EVM parity: omitted
    // optParams proposes nothing, exactly like "0x" — callers encode a fund
    // request via encodeFundTransferSetBudgetOptParams (the amount may
    // exceed the budget; token = default pubkey cancels a live proposal).
    const setBudgetOptParams: Uint8Array =
      params.optParams !== undefined
        ? hexToBytes(params.optParams)
        : EMPTY_OPT_PARAMS;

    if (hookAddress && isRouterHook(chainId, hookAddress)) {
      return this.setBudgetViaRouter(chainId, params, {
        signer,
        jobPda,
        clientAddress: job.data.client,
        providerAddress: job.data.provider,
        mintAddress,
        fundRequestParams: setBudgetOptParams,
      });
    }
    if (hookAddress && isSubscriptionHook(chainId, hookAddress)) {
      return this.setBudgetViaSubscriptionHook(chainId, params, {
        signer,
        jobPda,
        clientAddress: job.data.client,
        providerAddress: job.data.provider,
        mintAddress,
        rawOptParams: setBudgetOptParams,
      });
    }

    const ix = getSetBudgetInstruction(
      {
        caller: signer,
        job: jobPda,
        acpState: await this.deriveAcpStatePda(chainId),
        amount: params.amount,
        ...(hookAddress ? { hookProgram: hookAddress } : {}),
        ...(hookAddress
          ? { hookWhitelist: await this.deriveHookWhitelistPda(chainId, hookAddress) }
          : {}),
        optParams: setBudgetOptParams,
      },
      { programAddress: this.programAddress(chainId) }
    );

    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    if (hookAddress && setBudgetOptParams.length === 0) {
      // No proposal: post_set_budget no-ops on empty opt_params; the hook CPI
      // still needs its state account and the caller-validation sysvar. The
      // job account is appended because the core's minimum-hook-accounts guard requires more
      // than [hookState, sysvar] whenever amount > 0 on a hooked job — the
      // hook never reads it on the empty-opt_params early return.
      const SYSVAR_INSTRUCTIONS_ID =
        "Sysvar1nstructions1111111111111111111111111" as Address;
      const hookStatePda = await this.deriveHookStatePda(hookAddress);
      extraAccounts.push(
        { address: hookStatePda, role: AccountRole.WRITABLE },
        { address: SYSVAR_INSTRUCTIONS_ID, role: AccountRole.READONLY },
        { address: jobPda, role: AccountRole.READONLY }
      );
    } else if (hookAddress) {
      const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111" as Address;
      const SYSVAR_INSTRUCTIONS_ID =
        "Sysvar1nstructions1111111111111111111111111" as Address;
      const hookStatePda = await this.deriveHookStatePda(hookAddress);
      // The fund-request intent PDA is job-scoped — no counter read, no
      // renegotiation appendix (the hook overwrites the intent in place).
      const intentPda = await this.deriveIntentPda(
        hookAddress,
        jobPda,
        INTENT_KIND_FUND_REQUEST
      );
      const fundRequestIntentIdPda = await this.deriveFundRequestIntentIdPda(
        hookAddress,
        jobPda
      );

      extraAccounts.push(
        { address: hookStatePda, role: AccountRole.WRITABLE },
        { address: SYSVAR_INSTRUCTIONS_ID, role: AccountRole.READONLY },
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: intentPda, role: AccountRole.WRITABLE },
        { address: fundRequestIntentIdPda, role: AccountRole.WRITABLE },
        { address: jobPda, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY }
      );
    }

    return this.wrapMany(chainId, [
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
  }

  override async approveAllowance(
    chainId: number,
    _params: ApproveAllowanceParams
  ): Promise<PreparedSolanaTx> {
    throw new Error(
      "approveAllowance is not supported by SolanaAcpClient. Check capability flags first."
    );
  }

  override async fund(
    chainId: number,
    params: FundParams
  ): Promise<PreparedSolanaTx> {
    const rpc = this.provider.getRpc(chainId);
    const signer = this.provider.getSigner();
    const jobPda = await this.resolveJobPda(chainId, params.jobId, params.clientAddress);
    const job = await fetchJob(rpc, jobPda, { commitment: ACP_COMMITMENT });

    const vaultAuthorityPda = await this.deriveVaultAuthorityPda(chainId, jobPda);

    // No vault exists yet — fund() is what creates it (program `init`, not a
    // client-side ATA). budget_mint no longer exists on Job, so the mint is
    // simply the single global acp_state.payment_token; fund is also where
    // the allowlist check against it now happens on-chain.
    const acpStatePda = await this.deriveAcpStatePda(chainId);
    const acpState = await fetchAcpState(rpc, acpStatePda, { commitment: ACP_COMMITMENT });
    const mintAddress = acpState.data.paymentToken;

    const vaultPda = await this.deriveVaultPda(chainId, jobPda);
    const clientAta = await this.deriveAta(signer.address, mintAddress);

    const createClientAtaIx = this.buildCreateAtaIdempotentIx(
      signer.address,
      clientAta,
      signer.address,
      mintAddress
    );

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    if (hookAddress && isRouterHook(chainId, hookAddress)) {
      return this.fundViaRouter(chainId, params, {
        signer,
        jobPda,
        job,
        mintAddress,
        vaultPda,
        clientAta,
        vaultAuthorityPda,
        createClientAtaIx,
      });
    }
    if (hookAddress && isSubscriptionHook(chainId, hookAddress)) {
      return this.fundViaSubscriptionHook(chainId, params, {
        signer,
        jobPda,
        job,
        mintAddress,
        vaultPda,
        clientAta,
        vaultAuthorityPda,
        createClientAtaIx,
      });
    }

    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    const hookPreIxs: SolanaInstructionLike[] = [];
    const hookPostIxs: SolanaInstructionLike[] = [];
    // When the client's outer Approve bracket must survive into
    // post_fund (budget-mint intent above budget), the optional hook_delegate
    // account is omitted from the core fund instruction — the core's
    // approve/revoke both run only when hook_delegate is passed, and would
    // otherwise overwrite the bracket approval (single SPL delegate slot).
    let passHookDelegate = true;
    // The fund confirmation opt_params MUST match the on-chain fund-request
    // intent (token, amount, recipient) that post_set_budget created — the
    // hook validates them in post_fund via validate_intent_confirmation.
    // The intent carries whatever the provider proposed in setBudget
    // opt_params (any amount, any mint, any destination), so the confirmation
    // is always derived from the on-chain intent itself rather than from
    // params.optParams. Echoing the intent IS the client's consent to those
    // exact terms.
    let fundOptParams: Uint8Array = params.optParams
      ? hexToBytes(params.optParams)
      : EMPTY_OPT_PARAMS;

    if (hookAddress) {
      const SYSVAR_INSTRUCTIONS_ID =
        "Sysvar1nstructions1111111111111111111111111" as Address;
      const TOKEN_PROGRAM_ID =
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
      const hookStatePda = await this.deriveHookStatePda(hookAddress);
      const fundRequestIntentIdPda =
        await this.deriveFundRequestIntentIdPda(hookAddress, jobPda);
      // A hooked job may have no fund-request at all (nothing proposed,
      // or proposal cancelled — intent_id 0 sentinel). Even then, post_fund
      // still requires the fund-request map PDA at remaining[1]
      // so a client cannot skip a live request by
      // omitting it — the hook reads it and returns early when unset or
      // zero-sentinel. Omitting it fails IncompleteHookAccountSet (6019).
      // Mirrors the router fund fan-out no-request slice (routerLayout.ts).
      const maybeFriid = await fetchMaybeFundRequestIntentId(
        rpc,
        fundRequestIntentIdPda,
        { commitment: ACP_COMMITMENT }
      );
      if (!maybeFriid.exists || maybeFriid.data.intentId === 0n) {
        fundOptParams = EMPTY_OPT_PARAMS;
        extraAccounts.push(
          { address: hookStatePda, role: AccountRole.WRITABLE },
          { address: SYSVAR_INSTRUCTIONS_ID, role: AccountRole.READONLY },
          { address: fundRequestIntentIdPda, role: AccountRole.READONLY }
        );
      } else {
      const intentPda = await this.deriveIntentPda(
        hookAddress,
        jobPda,
        INTENT_KIND_FUND_REQUEST
      );
      const intent = await fetchIntent(rpc, intentPda, {
        commitment: ACP_COMMITMENT,
      });

      fundOptParams = hexToBytes(
        encodeFundTransferFundOptParams(
          chainId,
          intent.data.token,
          intent.data.amount,
          intent.data.recipient
        )
      );

      const fromAta = await this.deriveAta(intent.data.from, intent.data.token);
      const recipientAta = await this.deriveAta(
        intent.data.recipient,
        intent.data.token
      );

      hookPreIxs.push(
        this.buildCreateAtaIdempotentIx(
          signer.address,
          recipientAta,
          intent.data.recipient,
          intent.data.token
        )
      );

      // The core's delegate approval only covers the client's
      // budget-mint token account, bounded to budget_amount, funded jobs
      // only. Whenever that approval cannot cover the pull — foreign mint,
      // zero-budget job, or a budget-mint intent ABOVE the budget —
      // the client authorizes the exact intent amount with an outer
      // Approve/Revoke bracket around the fund instruction. For budget-mint
      // brackets the hook_delegate account is additionally omitted from the
      // core instruction so the core's own approve/revoke (which target the
      // same token account) do not clobber the bracket.
      const coreApprovalCovers =
        job.data.budgetAmount > 0n &&
        intent.data.token === mintAddress &&
        intent.data.amount <= job.data.budgetAmount;
      if (intent.data.amount > 0n && !coreApprovalCovers) {
        hookPreIxs.push(
          this.buildApproveIx(
            fromAta,
            hookStatePda,
            signer.address,
            intent.data.amount
          )
        );
        hookPostIxs.push(this.buildRevokeIx(fromAta, signer.address));
        if (intent.data.token === mintAddress) {
          passHookDelegate = false;
        }
      }

      extraAccounts.push(
        { address: hookStatePda, role: AccountRole.WRITABLE },
        { address: SYSVAR_INSTRUCTIONS_ID, role: AccountRole.READONLY },
        { address: fundRequestIntentIdPda, role: AccountRole.READONLY },
        { address: intentPda, role: AccountRole.WRITABLE },
        { address: fromAta, role: AccountRole.WRITABLE },
        { address: recipientAta, role: AccountRole.WRITABLE },
        { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY }
      );
      }
    }

    const ix = getFundInstruction(
      {
        client: signer,
        acpState: await this.deriveAcpStatePda(chainId),
        job: jobPda,
        clientTokenAccount: clientAta,
        vault: vaultPda,
        vaultAuthority: vaultAuthorityPda,
        mint: mintAddress,
        ...(hookAddress ? { hookProgram: hookAddress } : {}),
        ...(hookAddress
          ? { hookWhitelist: await this.deriveHookWhitelistPda(chainId, hookAddress) }
          : {}),
        ...(hookAddress && passHookDelegate
          ? { hookDelegate: await this.deriveHookDelegatePda(hookAddress) }
          : {}),
        expectedBudget: params.expectedBudget,
        optParams: fundOptParams,
      },
      { programAddress: this.programAddress(chainId) }
    );

    return this.wrapMany(chainId, [
      createClientAtaIx,
      ...hookPreIxs,
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
      ...hookPostIxs,
    ]);
  }

  override async submit(
    chainId: number,
    params: SubmitParams
  ): Promise<PreparedSolanaTx> {
    const rpc = this.provider.getRpc(chainId);
    const signer = this.provider.getSigner();
    const jobPda = await this.resolveJobPda(chainId, params.jobId, params.clientAddress);
    const job = await fetchJob(rpc, jobPda, { commitment: ACP_COMMITMENT });

    const deliverableBytes = encodeDeliverableBytes(params.deliverable);

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    const isFunded = job.data.budgetAmount > 0n;

    if (hookAddress && isRouterHook(chainId, hookAddress)) {
      return this.submitViaRouter(chainId, params, {
        signer,
        jobPda,
        job,
        deliverableBytes,
      });
    }
    if (hookAddress && isSubscriptionHook(chainId, hookAddress)) {
      return this.submitViaSubscriptionHook(chainId, params, {
        signer,
        jobPda,
        job,
        deliverableBytes,
      });
    }

    let vaultAccounts: Record<string, Address> = {};
    let hookNamedAccounts: Record<string, Address> = {};
    const preIxs: SolanaInstructionLike[] = [];
    const postIxs: SolanaInstructionLike[] = [];
    // Escrow-vault ATA creates for a FOREIGN-mint stake are split out and sent
    // eagerly before the submit tx: kept inline they push the sponsored,
    // rent-prefunded submit over the 1232-byte limit (foreign stake adds the
    // Approve/Revoke bracket on top of the budget-mint layout). Same treatment
    // as fund's ATA-split. Budget-mint stakes stay inline (they fit).
    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    let completeOptParams: Uint8Array = EMPTY_OPT_PARAMS;
    let submitOptParams: Uint8Array = params.optParams
      ? hexToBytes(params.optParams)
      : EMPTY_OPT_PARAMS;

    if (isFunded) {
      const vaultAuthorityPda = await this.deriveVaultAuthorityPda(chainId, jobPda);
      const acpStatePda = await this.deriveAcpStatePda(chainId);
      const acpState = await fetchAcpState(rpc, acpStatePda, { commitment: ACP_COMMITMENT });

      // budget_mint no longer exists on Job; the vault is a program-derived
      // account created at fund() time, so — since isFunded guarantees fund()
      // already ran — its own mint is authoritative and always fetchable here.
      const vaultPda = await this.deriveVaultPda(chainId, jobPda);
      const mintAddress = await this.fetchVaultMint(chainId, vaultPda);
      if (!mintAddress) {
        throw new Error(
          `submit: vault ${vaultPda} not found for a funded job (budget > 0); ` +
            `fund() should have created it.`
        );
      }
      const providerAta = await this.deriveAta(signer.address, mintAddress);
      const treasuryAta = await this.deriveAta(
        acpState.data.platformTreasury,
        mintAddress
      );

      preIxs.push(
        this.buildCreateAtaIdempotentIx(
          signer.address,
          providerAta,
          signer.address,
          mintAddress
        ),
        this.buildCreateAtaIdempotentIx(
          signer.address,
          treasuryAta,
          acpState.data.platformTreasury,
          mintAddress
        )
      );

      vaultAccounts = {
        vault: vaultPda,
        vaultAuthority: vaultAuthorityPda,
        providerTokenAccount: providerAta,
        treasuryTokenAccount: treasuryAta,
        // Native rent destination on close; distinct from platformTreasury,
        // which only ever receives the SPL fee via treasuryTokenAccount.
        sponsor: acpState.data.sponsor,
      };

      if (hookAddress) {
        const SYSVAR_INSTRUCTIONS_ID =
          "Sysvar1nstructions1111111111111111111111111" as Address;
        const SYSTEM_PROGRAM_ID =
          "11111111111111111111111111111111" as Address;
        const TOKEN_PROGRAM_ID =
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

        // The hook decodes the escrow proposal from submit opt_params
        // ([token 32][amount u64 LE 8]). Default: stake the full budget in
        // the budget mint (the legacy behavior). Callers override via
        // params.optParams — a foreign mint enables the atomic-swap mode,
        // "0x" proposes no escrow (evaluator jobs only, enforced on-chain).
        if (params.optParams === undefined) {
          submitOptParams = hexToBytes(
            encodeFundTransferSubmitOptParams(
              chainId,
              mintAddress,
              job.data.budgetAmount
            )
          );
        }
        const escrowProposal = decodeSolanaEscrowOptParams(submitOptParams);

        if (escrowProposal !== null) {
        const escrowToken = escrowProposal.token as Address;
        const escrowAmount = escrowProposal.amount;

        const hookStatePda = await this.deriveHookStatePda(hookAddress);
        // Job-scoped escrow intent PDA — no counter read, no race with
        // concurrent intent-creating transactions on the same hook.
        const escrowIntentPda = await this.deriveIntentPda(
          hookAddress,
          jobPda,
          INTENT_KIND_ESCROW
        );
        const provEscrowIntentIdPda =
          await this.deriveProviderEscrowIntentIdPda(
            hookAddress,
            jobPda
          );
        const escrowAuthorityPda = await this.deriveEscrowAuthorityPda(
          hookAddress,
          jobPda
        );
        const escrowVault = await this.deriveAta(
          escrowAuthorityPda,
          escrowToken
        );
        const providerEscrowAta = await this.deriveAta(
          signer.address,
          escrowToken
        );

        preIxs.push(
          this.buildCreateAtaIdempotentIx(
            signer.address,
            escrowVault,
            escrowAuthorityPda,
            escrowToken
          )
        );

        hookNamedAccounts = {
          hookDelegate: hookStatePda,
          providerHookTokenAccount: providerAta,
        };

        // post_submit layout: [hook_state, sysvar, payer, intent, map,
        // provider_token, escrow_vault, escrow_authority, token_program,
        // system_program, job]. The hook reads the job from the LAST slot of
        // its slice, so jobPda is included here even though the program also
        // appends it to the end of the full remaining set.
        const submitSlice: SolanaInstructionLike["accounts"] = [
          { address: hookStatePda, role: AccountRole.WRITABLE },
          { address: SYSVAR_INSTRUCTIONS_ID, role: AccountRole.READONLY },
          { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
          { address: escrowIntentPda, role: AccountRole.WRITABLE },
          { address: provEscrowIntentIdPda, role: AccountRole.WRITABLE },
          { address: providerEscrowAta, role: AccountRole.WRITABLE },
          { address: escrowVault, role: AccountRole.WRITABLE },
          { address: escrowAuthorityPda, role: AccountRole.READONLY },
          { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
          { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
          { address: jobPda, role: AccountRole.READONLY },
        ];

        const hasEvaluator = job.data.evaluator !== DEFAULT_PUBKEY;

        // A budget-mint stake ABOVE budget can no longer ride the core's
        // delegate approval — that approval (evaluator branch of submit) is
        // bounded to budget_amount. The hook's own budget-mint cap was removed
        // from post_submit, so the SDK now owns keeping the pull
        // authorized: bracket it with the provider's own Approve/Revoke and
        // (below) submit delegate-less. Mirrors the fund path.
        const overBudgetBudgetMint =
          escrowToken === mintAddress &&
          escrowAmount > job.data.budgetAmount;

        // Delegate coverage: the core approves the hook delegate
        // on providerHookTokenAccount (budget mint, bounded to budget_amount)
        // ONLY in the evaluator branch of submit. Whenever that approval does
        // not cover the escrow pull — no-evaluator auto-complete (on-chain
        // gap), a foreign-mint stake, or an over-budget budget-mint stake —
        // bracket the submit instruction in an outer Approve/Revoke on the
        // actual source account.
        const coreApprovalCovers =
          hasEvaluator && escrowToken === mintAddress && !overBudgetBudgetMint;
        if (escrowAmount > 0n && !coreApprovalCovers) {
          preIxs.push(
            this.buildApproveIx(
              providerEscrowAta,
              hookStatePda,
              signer.address,
              escrowAmount
            )
          );
          postIxs.push(this.buildRevokeIx(providerEscrowAta, signer.address));
        }

        // Over-budget budget-mint + evaluator: providerEscrowAta === providerAta,
        // so the core's own budget_amount approve/revoke around the hook CPI
        // would clobber the bracket allowance above and clamp the pull. Drop the
        // delegate (and its provider token account) so the core skips that
        // approve/revoke and the bracket survives. The no-evaluator path already
        // brackets without a core approve/revoke, so it passes the delegate
        // unchanged.
        if (hasEvaluator && overBudgetBudgetMint) {
          hookNamedAccounts = {};
        }

        if (hasEvaluator) {
          extraAccounts.push(...submitSlice);
        } else {
          // No evaluator: submit auto-completes in the same instruction, which
          // fires the after-Submit AND after-Complete hooks. after-Complete
          // routes to auto_sign_escrow, whose account layout differs from
          // post_submit's. Use per-action mode: a non-empty
          // completeOptParams whose first u16 LE is the number of accounts
          // (of remaining + appended job) belonging to the Submit slice.
          //
          // auto_sign_escrow layout: [hook_state, sysvar, escrow_map, intent,
          // escrow_vault, dest, escrow_authority, token_program]. dest must be
          // owned by intent.recipient == job.client (the escrow releases to
          // the client on completion; the appended job account is ignored).
          const clientAta = await this.deriveAta(job.data.client, escrowToken);
          preIxs.push(
            this.buildCreateAtaIdempotentIx(
              signer.address,
              clientAta,
              job.data.client,
              escrowToken
            )
          );

          const completeSlice: SolanaInstructionLike["accounts"] = [
            { address: hookStatePda, role: AccountRole.WRITABLE },
            { address: SYSVAR_INSTRUCTIONS_ID, role: AccountRole.READONLY },
            { address: provEscrowIntentIdPda, role: AccountRole.READONLY },
            { address: escrowIntentPda, role: AccountRole.WRITABLE },
            { address: escrowVault, role: AccountRole.WRITABLE },
            { address: clientAta, role: AccountRole.WRITABLE },
            { address: escrowAuthorityPda, role: AccountRole.READONLY },
            { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
          ];
          extraAccounts.push(...submitSlice, ...completeSlice);

          const submitCount = submitSlice.length;
          completeOptParams = new Uint8Array([
            submitCount & 0xff,
            (submitCount >> 8) & 0xff,
          ]);
        }
        } else {
          // "0x" override: no escrow proposed. post_submit enforces the
          // evaluator-or-escrow invariant on-chain
          // (EscrowRequiredWithoutEvaluator, fund hook post_submit) — a
          // no-evaluator job would also auto-complete here, and the empty
          // completeOptParams split would hand the after-Complete hook a
          // misaligned slice. Fail fast client-side instead of burning a
          // sponsored simulation.
          if (job.data.evaluator === DEFAULT_PUBKEY) {
            throw new Error(
              "No-escrow submit (optParams \"0x\") requires an evaluator: " +
                "the fund hook rejects it with EscrowRequiredWithoutEvaluator " +
                "because a no-evaluator job auto-completes with no recourse. " +
                "Propose an escrow stake or create the job with an evaluator."
            );
          }
          // The hook CPI still needs its state account and the
          // caller-validation sysvar (the program appends the job account the
          // hook reads last). The job account is additionally passed because
          // the core's minimum-hook-accounts guard on submit requires more than
          // [hookState, sysvar] whenever budget > 0 on a hooked job — without
          // it the core rejects the tx with MissingRequiredAccount before the
          // hook's semantic check runs.
          const hookStatePda = await this.deriveHookStatePda(hookAddress);
          extraAccounts.push(
            { address: hookStatePda, role: AccountRole.WRITABLE },
            { address: SYSVAR_INSTRUCTIONS_ID, role: AccountRole.READONLY },
            { address: jobPda, role: AccountRole.READONLY }
          );
        }
      }
    } else if (hookAddress) {
      const hookStatePda = await this.deriveHookStatePda(hookAddress);
      extraAccounts.push({
        address: hookStatePda,
        role: AccountRole.WRITABLE,
      });
    }

    const ix = await getSubmitInstructionAsync(
      {
        provider: signer,
        job: jobPda,
        acpState: await this.deriveAcpStatePda(chainId),
        deliverable: deliverableBytes,
        ...(hookAddress ? { hookProgram: hookAddress } : {}),
        ...(hookAddress
          ? { hookWhitelist: await this.deriveHookWhitelistPda(chainId, hookAddress) }
          : {}),
        ...vaultAccounts,
        ...hookNamedAccounts,
        optParams: submitOptParams,
        completeOptParams,
      },
      { programAddress: this.programAddress(chainId) }
    );

    return this.wrapMany(chainId, [
      ...preIxs,
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
      ...postIxs,
    ]);
  }

  override async complete(
    chainId: number,
    params: CompleteParams
  ): Promise<PreparedSolanaTx> {
    const rpc = this.provider.getRpc(chainId);
    const signer = this.provider.getSigner();
    const jobPda = await this.resolveJobPda(chainId, params.jobId, params.clientAddress);
    const job = await fetchJob(rpc, jobPda, { commitment: ACP_COMMITMENT });

    const completeHookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;
    if (
      completeHookAddress &&
      (isRouterHook(chainId, completeHookAddress) ||
        isSubscriptionHook(chainId, completeHookAddress))
    ) {
      throw new Error(
        "complete() cannot prepare a subscription-activating job (router or " +
          "standalone subscription hook): the on-chain activation requires " +
          "the provider's co-signature, which cannot ride in a prepared " +
          "transaction. Use completeSubscriptionJob(chainId, { ...params, " +
          "providerSigner }) instead — it sends eagerly through the " +
          "sponsored multi-signer path (router jobs compress against the " +
          "persistent complete lookup table)."
      );
    }

    const reasonBytes = encodeReasonBytes(params.reason);

    const vaultAuthorityPda = await this.deriveVaultAuthorityPda(chainId, jobPda);

    const acpStatePda = await this.deriveAcpStatePda(chainId);
    const acpState = await fetchAcpState(rpc, acpStatePda, { commitment: ACP_COMMITMENT });

    // complete() runs on zero-budget jobs too, where no vault was ever
    // created — fetchVaultMint then returns null and acp_state.payment_token
    // (the same fallback budgetMint.None used) stands in. It is never actually
    // read from for a zero-budget job; the derived accounts below just need a
    // valid mint to compute ATAs against.
    const vaultPda = await this.deriveVaultPda(chainId, jobPda);
    const mintAddress =
      (await this.fetchVaultMint(chainId, vaultPda)) ?? acpState.data.paymentToken;
    const providerAta = await this.deriveAta(job.data.provider, mintAddress);
    const treasuryAta = await this.deriveAta(
      acpState.data.platformTreasury,
      mintAddress
    );

    let evaluatorAta: Address | undefined;
    if (
      acpState.data.evaluatorFeeBp > 0n &&
      job.data.evaluator !== DEFAULT_PUBKEY
    ) {
      evaluatorAta = await this.deriveAta(job.data.evaluator, mintAddress);
    }

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    const preIxs: SolanaInstructionLike[] = [];

    // The evaluator fee ATA is the one destination the lifecycle never
    // provisions: `submit` idempotently creates the provider + treasury ATAs
    // (see setBudget/submit), and the hook branch below creates the escrow
    // recipient ATA, but nothing creates the evaluator's fee ATA. A fresh
    // evaluator would otherwise revert with AccountNotInitialized (3012) on
    // the fee transfer. `complete` is signed by the evaluator, so create it
    // here idempotently (owner == signer == job.data.evaluator). No-op if it
    // already exists; sponsorship/self-pay covers the rent.
    if (evaluatorAta) {
      preIxs.push(
        this.buildCreateAtaIdempotentIx(
          signer.address,
          evaluatorAta,
          job.data.evaluator,
          mintAddress
        )
      );
    }

    if (hookAddress) {
      const SYSVAR_INSTRUCTIONS_ID =
        "Sysvar1nstructions1111111111111111111111111" as Address;
      const TOKEN_PROGRAM_ID =
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

      const hookStatePda = await this.deriveHookStatePda(hookAddress);
      const provEscrowIntentIdPda =
        await this.deriveProviderEscrowIntentIdPda(
          hookAddress,
          jobPda
        );
      // The escrow-map PDA is mandatory at the hook's remaining[1] even with
      // no escrow: auto_sign_escrow fails IncompleteHookAccountSet (6019) on
      // a truncated set so a live escrow cannot be skipped by omitting
      // accounts. The hook no-ops when the map is unset or holds the
      // intentId=0 sentinel.
      extraAccounts.push(
        { address: hookStatePda, role: AccountRole.WRITABLE },
        { address: SYSVAR_INSTRUCTIONS_ID, role: AccountRole.READONLY },
        { address: provEscrowIntentIdPda, role: AccountRole.READONLY }
      );

      const maybePeii = await fetchMaybeProviderEscrowIntentId(
        rpc,
        provEscrowIntentIdPda,
        { commitment: ACP_COMMITMENT }
      );

      // A pre-created (zeroed) map means no escrow was ever proposed —
      // intentId 0 is the unset sentinel, not a live escrow.
      if (maybePeii.exists && maybePeii.data.intentId !== 0n) {
        const escrowIntentPda = await this.deriveIntentPda(
          hookAddress,
          jobPda,
          INTENT_KIND_ESCROW
        );
        const intent = await fetchIntent(rpc, escrowIntentPda, {
          commitment: ACP_COMMITMENT,
        });
        const escrowAuthorityPda = await this.deriveEscrowAuthorityPda(
          hookAddress,
          jobPda
        );
        const escrowVault = await this.deriveAta(
          escrowAuthorityPda,
          intent.data.token
        );
        const recipientAta = await this.deriveAta(
          intent.data.recipient,
          intent.data.token
        );

        preIxs.push(
          this.buildCreateAtaIdempotentIx(
            signer.address,
            recipientAta,
            intent.data.recipient,
            intent.data.token
          )
        );

        extraAccounts.push(
          { address: escrowIntentPda, role: AccountRole.WRITABLE },
          { address: escrowVault, role: AccountRole.WRITABLE },
          { address: recipientAta, role: AccountRole.WRITABLE },
          { address: escrowAuthorityPda, role: AccountRole.READONLY },
          { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY }
        );
      }
    }

    const ix = await getCompleteInstructionAsync(
      {
        evaluator: signer,
        job: jobPda,
        acpState: acpStatePda,
        vault: vaultPda,
        vaultAuthority: vaultAuthorityPda,
        providerTokenAccount: providerAta,
        treasuryTokenAccount: treasuryAta,
        ...(evaluatorAta ? { evaluatorTokenAccount: evaluatorAta } : {}),
        sponsor: acpState.data.sponsor,
        ...(hookAddress ? { hookProgram: hookAddress } : {}),
        ...(hookAddress
          ? { hookWhitelist: await this.deriveHookWhitelistPda(chainId, hookAddress) }
          : {}),
        reason: reasonBytes,
        optParams: params.optParams
          ? hexToBytes(params.optParams)
          : EMPTY_OPT_PARAMS,
      },
      { programAddress: this.programAddress(chainId) }
    );

    return this.wrapMany(chainId, [
      ...preIxs,
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
  }

  override async reject(
    chainId: number,
    params: RejectParams
  ): Promise<PreparedSolanaTx> {
    const rpc = this.provider.getRpc(chainId);
    const signer = this.provider.getSigner();
    const jobPda = await this.resolveJobPda(chainId, params.jobId, params.clientAddress);
    const job = await fetchJob(rpc, jobPda, { commitment: ACP_COMMITMENT });
    const acpStatePda = await this.deriveAcpStatePda(chainId);
    const acpState = await fetchAcpState(rpc, acpStatePda, {
      commitment: ACP_COMMITMENT,
    });

    const reasonBytes = encodeReasonBytes(params.reason);

    const isFunded =
      job.data.state === JOB_STATE_FUNDED ||
      job.data.state === JOB_STATE_SUBMITTED;

    let vault: Address | undefined;
    let vaultAuthority: Address | undefined;
    let clientTokenAccount: Address | undefined;

    if (isFunded && job.data.budgetAmount > 0n) {
      vaultAuthority = await this.deriveVaultAuthorityPda(chainId, jobPda);

      vault = await this.deriveVaultPda(chainId, jobPda);
      const mintAddress = await this.fetchVaultMint(chainId, vault);
      if (!mintAddress) {
        throw new Error(
          `reject: vault ${vault} not found for a funded job (budget > 0); ` +
            `fund() should have created it.`
        );
      }
      clientTokenAccount = await this.deriveAta(job.data.client, mintAddress);
    }

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    if (hookAddress && isRouterHook(chainId, hookAddress)) {
      return this.rejectViaRouter(chainId, params, {
        signer,
        jobPda,
        job,
        reasonBytes,
        vault,
        vaultAuthority,
        clientTokenAccount,
        sponsor: acpState.data.sponsor,
      });
    }
    if (hookAddress && isSubscriptionHook(chainId, hookAddress)) {
      return this.rejectViaSubscriptionHook(chainId, params, {
        signer,
        jobPda,
        job,
        reasonBytes,
        vault,
        vaultAuthority,
        clientTokenAccount,
        sponsor: acpState.data.sponsor,
      });
    }

    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    if (hookAddress) {
      const SYSVAR_INSTRUCTIONS_ID =
        "Sysvar1nstructions1111111111111111111111111" as Address;
      const TOKEN_PROGRAM_ID =
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

      const hookStatePda = await this.deriveHookStatePda(hookAddress);
      const provEscrowIntentIdPda =
        await this.deriveProviderEscrowIntentIdPda(
          hookAddress,
          jobPda
        );
      // The escrow-map PDA is mandatory at the hook's remaining[1] even with
      // no escrow: auto_sign_escrow fails IncompleteHookAccountSet (6019) on
      // a truncated set so a live escrow cannot be skipped by omitting
      // accounts. The hook no-ops when the map is unset or holds the
      // intentId=0 sentinel.
      extraAccounts.push(
        { address: hookStatePda, role: AccountRole.WRITABLE },
        { address: SYSVAR_INSTRUCTIONS_ID, role: AccountRole.READONLY },
        { address: provEscrowIntentIdPda, role: AccountRole.READONLY }
      );

      const maybePeii = await fetchMaybeProviderEscrowIntentId(
        rpc,
        provEscrowIntentIdPda,
        { commitment: ACP_COMMITMENT }
      );

      // A pre-created (zeroed) map means no escrow was ever proposed —
      // intentId 0 is the unset sentinel, not a live escrow.
      if (maybePeii.exists && maybePeii.data.intentId !== 0n) {
        const escrowIntentPda = await this.deriveIntentPda(
          hookAddress,
          jobPda,
          INTENT_KIND_ESCROW
        );
        const intent = await fetchIntent(rpc, escrowIntentPda, {
          commitment: ACP_COMMITMENT,
        });
        const escrowAuthorityPda = await this.deriveEscrowAuthorityPda(
          hookAddress,
          jobPda
        );
        const escrowVault = await this.deriveAta(
          escrowAuthorityPda,
          intent.data.token
        );
        const providerAta = await this.deriveAta(
          intent.data.from,
          intent.data.token
        );

        extraAccounts.push(
          { address: escrowIntentPda, role: AccountRole.WRITABLE },
          { address: escrowVault, role: AccountRole.WRITABLE },
          { address: providerAta, role: AccountRole.WRITABLE },
          { address: escrowAuthorityPda, role: AccountRole.READONLY },
          { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY }
        );
      }
    }

    const ix = await getRejectInstructionAsync(
      {
        caller: signer,
        job: jobPda,
        acpState: acpStatePda,
        ...(vault ? { vault } : {}),
        ...(vaultAuthority ? { vaultAuthority } : {}),
        ...(clientTokenAccount ? { clientTokenAccount } : {}),
        sponsor: acpState.data.sponsor,
        ...(hookAddress ? { hookProgram: hookAddress } : {}),
        ...(hookAddress
          ? { hookWhitelist: await this.deriveHookWhitelistPda(chainId, hookAddress) }
          : {}),
        reason: reasonBytes,
        optParams: params.optParams
          ? hexToBytes(params.optParams)
          : EMPTY_OPT_PARAMS,
      },
      { programAddress: this.programAddress(chainId) }
    );

    return this.wrapMany(chainId, [
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
  }

  /**
   * Decodes the JobCreated event out of a confirmed transaction's logs, or
   * null if the transaction is missing or carries no such event. Shared by
   * getJobIdFromTxHash (needs `.job`) and getJob's description recovery
   * (needs `.description`) so the log-scanning logic lives in one place.
   */
  private async decodeJobCreatedFromTx(
    chainId: number,
    txHash: string
  ): Promise<import("../core/solana/generated/acp/types/jobCreated.js").JobCreated | null> {
    const rpc = this.provider.getRpc(chainId);
    const tx = await rpc
      .getTransaction(txHash as Signature, {
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (!tx) return null;

    const decoder = getJobCreatedDecoder();
    for (const log of tx.meta?.logMessages ?? []) {
      if (!log.startsWith("Program data: ")) continue;
      const data = Uint8Array.from(
        atob(log.slice("Program data: ".length)),
        (c) => c.charCodeAt(0)
      );
      if (data.length < 8) continue;
      if (!JOB_CREATED_EVENT_DISC.every((b, i) => data[i] === b)) continue;
      return decoder.decode(data.slice(8));
    }
    return null;
  }

  /**
   * Recovers the chain-agnostic bigint jobId (the seed passed to createJob)
   * from a confirmed createJob transaction.
   *
   * The job's identity is now its own account address, and JobCreated only
   * carries that address (`job`), not the seed — the seed is a write-once
   * input, not part of the job's on-chain identity, so the event does not
   * echo it. This decodes the event to find the address, then fetches the
   * job account itself and reads `seed` back off it (the account still
   * stores it, purely so the PDA can be re-derived). One extra RPC round
   * trip versus the old counter-value-in-the-event scheme, in exchange for
   * keeping this method's external bigint contract unchanged.
   */
  override async getJobIdFromTxHash(
    chainId: number,
    txHash: string
  ): Promise<bigint | null> {
    const event = await this.decodeJobCreatedFromTx(chainId, txHash);
    if (!event) return null;

    const rpc = this.provider.getRpc(chainId);
    const jobAccount = await fetchJob(rpc, event.job, {
      commitment: ACP_COMMITMENT,
    });
    return jobAccount.data.seed;
  }

  /**
   * Signature of the transaction that created the given job, recovered from
   * the job PDA's history (`getSignaturesForAddress`, oldest entry). Keyed by
   * jobId, so it stays correct when one agent runs multiple jobs concurrently.
   * Read-side helper for scripts/observability; costs one RPC round-trip.
   */
  async getCreateSignature(
    chainId: number,
    jobId: bigint,
    clientAddress?: string
  ): Promise<string | null> {
    const rpc = this.provider.getRpc(chainId);
    const jobPda = await this.resolveJobPda(chainId, jobId, clientAddress);

    // Newest-first; the job PDA's oldest signature is its creation tx.
    // Literal "confirmed" (= ACP_COMMITMENT's value): this RPC method's type
    // rejects the wider Commitment type, which includes "processed".
    const signatures = await rpc
      .getSignaturesForAddress(jobPda, { commitment: "confirmed" })
      .send();
    if (signatures.length === 0) return null;

    return signatures[signatures.length - 1]!.signature;
  }

  override async getJob(
    chainId: number,
    jobId: bigint,
    clientAddress?: string
  ): Promise<OnChainJob | null> {
    const rpc = this.provider.getRpc(chainId);
    const jobPda = await this.resolveJobPda(chainId, jobId, clientAddress);

    try {
      const jobAccount = await fetchJob(rpc, jobPda, {
        commitment: ACP_COMMITMENT,
      });
      const job = jobAccount.data;

      // description moved to event-only (JobCreated.description) — it is no
      // longer stored on the Job account at all. Recover it from the job's
      // creation transaction, the only place it still exists on-chain. Best
      // effort: a job created before an RPC's log-retention window, or one
      // whose creation tx cannot be located, degrades to "" rather than
      // failing the whole read.
      let description = "";
      const createSig = await rpc
        .getSignaturesForAddress(jobPda, { commitment: "confirmed" })
        .send();
      if (createSig.length > 0) {
        const event = await this.decodeJobCreatedFromTx(
          chainId,
          createSig[createSig.length - 1]!.signature
        );
        if (event) description = event.description;
      }

      return {
        id: job.seed,
        client: job.client,
        provider: job.provider,
        evaluator: job.evaluator,
        description,
        budget: job.budgetAmount,
        expiredAt: job.expiredAt,
        status: job.state as number,
        hook: job.hookAddress.__option === "Some" ? job.hookAddress.value : "",
      };
    } catch (err) {
      console.error(`Failed to fetch job ${jobId} at PDA ${jobPda}:`, err);
      return null;
    }
  }

  override async getTokenDecimals(
    chainId: number,
    tokenAddress: string
  ): Promise<number> {
    const rpc = this.provider.getRpc(chainId);
    const accountInfo = await rpc
      .getAccountInfo(tokenAddress as Address, { encoding: "base64" })
      .send();

    if (!accountInfo.value) {
      throw new Error(`Mint account not found: ${tokenAddress}`);
    }

    // SPL Token mint layout: decimals is at offset 44, 1 byte
    const data = Uint8Array.from(
      atob(accountInfo.value.data[0] as string),
      (c) => c.charCodeAt(0)
    );
    return data[44]!;
  }

  override async getTokenSymbol(
    chainId: number,
    _tokenAddress: string
  ): Promise<string> {
    throw new Error(
      "getTokenSymbol is not supported on Solana. Use AssetToken.create() with explicit symbol."
    );
  }

  /**
   * Configure a multi-hook-router job's per-selector sub-hook lists.
   * Client-only, and only while the job is on-chain Open — the router locks
   * configuration once the job leaves Open (HooksLocked). Prepared builder;
   * the instruction targets the router program and is sponsored like other
   * ACP actions.
   */
  override async batchConfigureHooks(
    chainId: number,
    params: BatchConfigureHooksParams
  ): Promise<PreparedSolanaTx> {
    const signer = this.provider.getSigner();
    const ctx = routerContext(chainId);
    if (params.routerAddress !== ctx.router) {
      throw new Error(
        `batchConfigureHooks: routerAddress ${params.routerAddress} is not ` +
          `the multi-hook router deployed on chain ${chainId} (${ctx.router}).`
      );
    }

    // On-chain each selector is Option<Vec<Pubkey>>: Some(list) replaces that
    // selector's list (an empty vec clears it), None leaves it unchanged. A
    // selector the caller does not name is sent as null (None) so a partial
    // reconfigure of an Open job does not silently wipe the selectors it omits;
    // named selectors are sent as their list (Some), an empty list clearing.
    const selectorFields: Record<string, Address[] | null> = {
      [ACP_SELECTORS.setBudget]: null,
      [ACP_SELECTORS.fund]: null,
      [ACP_SELECTORS.submit]: null,
      [ACP_SELECTORS.complete]: null,
      [ACP_SELECTORS.reject]: null,
    };
    params.selectors.forEach((selector, i) => {
      if (!(selector in selectorFields)) {
        throw new Error(
          `batchConfigureHooks: unknown selector ${selector}; expected one ` +
            `of the ACP_SELECTORS values.`
        );
      }
      selectorFields[selector] = (params.hooksPerSelector[i] ?? []).map(
        (h) => h as Address
      );
    });
    const lists = {
      setBudget: selectorFields[ACP_SELECTORS.setBudget]!,
      fund: selectorFields[ACP_SELECTORS.fund]!,
      submit: selectorFields[ACP_SELECTORS.submit]!,
      complete: selectorFields[ACP_SELECTORS.complete]!,
      reject: selectorFields[ACP_SELECTORS.reject]!,
    };

    // The configurer must be the job's client (OnlyJobClient on-chain), so
    // the job PDA resolves against the signer when no cache entry exists.
    const jobPda = await this.resolveJobPda(chainId, params.jobId);
    const ix = await getBatchConfigureHooksInstructionAsync(
      {
        client: signer,
        job: jobPda,
        hookRouter: await hookRouterPda(ctx.router, jobPda),
        routerState: await routerStatePda(ctx.router),
        systemProgram: "11111111111111111111111111111111" as Address,
        jobKey: jobPda,
        ...lists,
      },
      { programAddress: ctx.router }
    );

    return this.wrapMany(chainId, [
      {
        programAddress: ix.programAddress,
        accounts: [
          ...ix.accounts,
          // Only Some (provided) selectors contribute hooks to the router's
          // remaining-accounts validation set; None selectors are skipped.
          ...(await batchConfigureHooksExtraAccounts(
            ctx.acp,
            [
              lists.setBudget,
              lists.fund,
              lists.submit,
              lists.complete,
              lists.reject,
            ].filter((l): l is Address[] => l !== null)
          )),
        ],
        data: ix.data as Uint8Array,
      },
    ]);
  }

  /**
   * Complete a subscription-activating job — a multi-hook (router) job or a
   * standalone subscription-hook job. EAGER — sends immediately and returns
   * the signature, deviating from the prepared pattern because it needs a
   * runtime lookup-table/retry-guard setup that doesn't ride in prepared
   * data.
   *
   * `providerSigner` is accepted for backward compatibility but is no longer
   * required (F-118): the provider used to have to co-sign because
   * ActivateSubscription's on-chain payer was declared a Signer, allocating
   * sub_expiry at activation. sub_expiry is now pre-created at set_budget, so
   * activation allocates nothing and the evaluator completes alone.
   *
   * Router jobs additionally need an address lookup table (the fan-out
   * account set exceeds the legacy tx size) — they compress against the
   * persistent complete ALT (MULTI_HOOK_COMPLETE_ALT_ADDRESSES). Standalone
   * subscription jobs fit a legacy transaction and need no table. Both kinds
   * send through the sponsored path, so fees and rents — including
   * first-activation sub_expiry — are prefunded and no wallet needs SOL.
   */
  async completeSubscriptionJob(
    chainId: number,
    params: CompleteParams & { providerSigner?: SolanaSigner }
  ): Promise<string> {
    const rpc = this.provider.getRpc(chainId);
    const signer = this.provider.getSigner();
    const jobPda = await this.resolveJobPda(
      chainId,
      params.jobId,
      params.clientAddress
    );
    const job = await fetchJob(rpc, jobPda, { commitment: ACP_COMMITMENT });

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;
    const isRouter = !!hookAddress && isRouterHook(chainId, hookAddress);
    const isStandaloneSub =
      !!hookAddress && isSubscriptionHook(chainId, hookAddress);
    if (!isRouter && !isStandaloneSub) {
      throw new Error(
        "completeSubscriptionJob requires a multi-hook (router) or " +
          "standalone subscription-hook job; use complete() + " +
          "submitPrepared for other jobs."
      );
    }
    // providerSigner is no longer required (F-118) — only validate it when a
    // caller supplies one, so a stale/wrong signer isn't silently ignored.
    if (
      params.providerSigner &&
      params.providerSigner.address !== job.data.provider
    ) {
      throw new Error(
        `completeSubscriptionJob: providerSigner ${params.providerSigner.address} ` +
          `is not the job's provider ${job.data.provider}.`
      );
    }

    if (isStandaloneSub) {
      return this.completeSubscriptionStandalone(chainId, params, {
        signer,
        jobPda,
        job,
      });
    }

    const ctx = routerContext(chainId);

    // Fail fast: router complete requires the persistent complete lookup
    // table. Without it the old fallback created a fresh per-job ALT whose
    // ~0.0084 SOL rent is not gas-sponsorable (Alchemy's prefundRent covers
    // createAccount/ATA rent, not ALT-account rent) and is never reclaimed —
    // silently leaking evaluator SOL on every complete.
    if (!MULTI_HOOK_COMPLETE_ALT_ADDRESSES[chainId]) {
      throw new Error(
        `completeSubscriptionJob: no complete lookup table is configured ` +
          `for chain ${chainId}, so router job completion is not available ` +
          `on this cluster.`
      );
    }

    const acpStatePda = await this.deriveAcpStatePda(chainId);
    const acpState = await fetchAcpState(rpc, acpStatePda, {
      commitment: ACP_COMMITMENT,
    });
    const vaultAuthorityPda = await this.deriveVaultAuthorityPda(chainId, jobPda);
    const vaultPda = await this.deriveVaultPda(chainId, jobPda);
    const mintAddress =
      (await this.fetchVaultMint(chainId, vaultPda)) ?? acpState.data.paymentToken;
    const providerAta = await this.deriveAta(job.data.provider, mintAddress);
    const treasuryAta = await this.deriveAta(
      acpState.data.platformTreasury,
      mintAddress
    );

    const preIxs: SolanaInstructionLike[] = [];
    let evaluatorAta: Address | undefined;
    if (
      acpState.data.evaluatorFeeBp > 0n &&
      job.data.evaluator !== DEFAULT_PUBKEY
    ) {
      evaluatorAta = await this.deriveAta(job.data.evaluator, mintAddress);
      preIxs.push(
        this.buildCreateAtaIdempotentIx(
          signer.address,
          evaluatorAta,
          job.data.evaluator,
          mintAddress
        )
      );
    }

    // Proposed terms drive the subscription slice; escrow intent drives the
    // fund-hook release slice. Either may be absent (no-op slices).
    const terms = await fetchProposedTerms(
      rpc,
      ctx.subHook,
      jobPda,
      ACP_COMMITMENT
    );

    let escrow: {
      clientAta: Address;
      escrowVault: Address;
      escrowAuthority: Address;
    } | null = null;
    const provEscrowIntentIdPda = await this.deriveProviderEscrowIntentIdPda(
      ctx.fundHook,
      jobPda
    );
    const maybePeii = await fetchMaybeProviderEscrowIntentId(
      rpc,
      provEscrowIntentIdPda,
      { commitment: ACP_COMMITMENT }
    );
    // A pre-created (zeroed) map means no escrow was ever proposed —
    // intentId 0 is the unset sentinel, not a live escrow.
    if (maybePeii.exists && maybePeii.data.intentId !== 0n) {
      const escrowIntentPda = await this.deriveIntentPda(
        ctx.fundHook,
        jobPda,
        INTENT_KIND_ESCROW
      );
      const intent = await fetchIntent(rpc, escrowIntentPda, {
        commitment: ACP_COMMITMENT,
      });
      const escrowAuthorityPda = await this.deriveEscrowAuthorityPda(
        ctx.fundHook,
        jobPda
      );
      const escrowVault = await this.deriveAta(
        escrowAuthorityPda,
        intent.data.token
      );
      const recipientAta = await this.deriveAta(
        intent.data.recipient,
        intent.data.token
      );
      preIxs.push(
        this.buildCreateAtaIdempotentIx(
          signer.address,
          recipientAta,
          intent.data.recipient,
          intent.data.token
        )
      );
      escrow = {
        clientAta: recipientAta,
        escrowVault,
        escrowAuthority: escrowAuthorityPda,
      };
    }

    const fanOut = await buildCompleteFanOut(ctx, {
      jobPda,
      provider: job.data.provider,
      clientAddress: job.data.client,
      packageId: terms ? terms.packageId : null,
      escrow,
    });

    const ix = await getCompleteInstructionAsync(
      {
        evaluator: signer,
        job: jobPda,
        acpState: acpStatePda,
        vault: vaultPda,
        vaultAuthority: vaultAuthorityPda,
        providerTokenAccount: providerAta,
        treasuryTokenAccount: treasuryAta,
        ...(evaluatorAta ? { evaluatorTokenAccount: evaluatorAta } : {}),
        sponsor: acpState.data.sponsor,
        hookProgram: ctx.router,
        hookWhitelist: await this.deriveHookWhitelistPda(chainId, ctx.router),
        reason: encodeReasonBytes(params.reason),
        optParams: fanOut.optParams,
      },
      { programAddress: this.programAddress(chainId) }
    );

    const instructions: SolanaInstructionLike[] = [
      cuLimitIx(),
      ...preIxs,
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...fanOut.extraAccounts],
        data: ix.data as Uint8Array,
      },
    ];

    // Compress non-signer accounts through the PERSISTENT complete lookup
    // table: a pre-created table holding complete's ~18 globally-static
    // accounts (programs, sysvars, router/hook/sub-state PDAs, treasury),
    // reused across every complete. Its rent was paid once at setup; the
    // per-job accounts stay uncompressed. Fully propagated (no sponsor-node
    // lag) and creates nothing, so the complete is SPONSORED and the
    // evaluator pays no SOL. Set up once by the ACP upgrade-authority keypair
    // → MULTI_HOOK_COMPLETE_ALT_ADDRESSES; absence throws at the top of
    // completeSubscriptionJob before any account fetch.
    //
    // Re-derive the static accounts in the SAME order the setup script used
    // to extend the table, so the on-chain index references line up.
    const lut = MULTI_HOOK_COMPLETE_ALT_ADDRESSES[chainId] as Address;
    const addresses = await this.completeStaticAltAccounts(chainId);

    // The complete simulates on Alchemy's node, which can lag the submit that
    // just moved the job to Submitted — surfacing a GUARDED WrongStatus. The
    // retry guard confirms on our own RPC that the job really is Submitted
    // (sponsor-node lag → retry) vs genuinely wrong (fail fast).
    const { guard } = buildJobStateRetryGuard(
      this.provider.getRpc(chainId),
      this.programAddress(chainId),
      instructions,
    );
    // sub_expiry already on-chain (pre-created at setBudget, or a renewal over
    // a live subscription) means complete creates nothing at depth 4+ — a zero
    // prefund is expected, so suppress the router prefund warning.
    let hookRentPreCreated = false;
    if (terms) {
      const subExpiry = await subExpiryPda(
        ctx.subState,
        job.data.client,
        job.data.provider,
        terms.packageId
      );
      const existing = await this.provider
        .getRpc(chainId)
        .getAccountInfo(subExpiry, { encoding: "base64" })
        .send();
      hookRentPreCreated = existing.value !== null;
    }
    const result = await this.provider.sendInstructions(chainId, instructions, {
      extraSigners:
        fanOut.requiredExtraSigner && params.providerSigner
          ? [params.providerSigner]
          : [],
      lookupTables: { [lut]: addresses },
      retryGuard: guard,
      sponsorLookupTables: true,
      hookRentPreCreated,
    });
    return Array.isArray(result) ? result[0]! : result;
  }

  /**
   * Complete's globally-static accounts — the ones that never vary per job:
   * programs, sysvars, and program-derived PDAs (router/hook state, whitelists,
   * writer registry, ACP state, treasury). These populate the persistent
   * complete lookup table. The ORDER here is the contract: the setup script
   * extends the table in this order, and complete re-derives the same list to
   * compress against it, so the on-chain address indices match. Mint-dependent
   * (treasury ATA uses the default payment mint) — a custom-mint job simply
   * leaves its treasury ATA uncompressed, which is harmless.
   */
  async completeStaticAltAccounts(chainId: number): Promise<Address[]> {
    const ctx = routerContext(chainId);
    const acp = this.programAddress(chainId);
    const rpc = this.provider.getRpc(chainId);
    const acpStatePda = await this.deriveAcpStatePda(chainId);
    const acpState = await fetchAcpState(rpc, acpStatePda, {
      commitment: ACP_COMMITMENT,
    });
    const treasury = acpState.data.platformTreasury;
    const treasuryAta = await this.deriveAta(
      treasury,
      acpState.data.paymentToken
    );
    const COMPUTE_BUDGET =
      "ComputeBudget111111111111111111111111111111" as Address;
    const TOKEN_PROGRAM =
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
    const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
    const SYSVAR_INSTRUCTIONS =
      "Sysvar1nstructions1111111111111111111111111" as Address;
    void acp;
    return [
      COMPUTE_BUDGET,
      ctx.router as Address,
      await routerStatePda(ctx.router),
      SYSVAR_INSTRUCTIONS,
      ctx.subHook as Address,
      await this.deriveHookWhitelistPda(chainId, ctx.subHook),
      ctx.fundHook as Address,
      await this.deriveHookWhitelistPda(chainId, ctx.fundHook),
      await this.deriveHookStatePda(ctx.subHook),
      ctx.subState as Address,
      await writerRegistryPda(ctx.subState, ctx.subHook),
      SYSTEM_PROGRAM,
      await this.deriveHookStatePda(ctx.fundHook),
      TOKEN_PROGRAM,
      acpStatePda,
      treasury,
      treasuryAta,
      await this.deriveHookWhitelistPda(chainId, ctx.router),
    ];
  }

  /**
   * DEPRECATED for new tables: this signs with the adapter's wallet, so the
   * table's authority lands on a runtime wallet. Protocol infra must be owned
   * by the ACP upgrade-authority keypair — create tables with that keypair
   * instead (same account list + order).
   *
   * One-time setup: create + warm the persistent complete lookup table for a
   * cluster over {@link completeStaticAltAccounts}. Returns its address to
   * paste into MULTI_HOOK_COMPLETE_ALT_ADDRESSES. The creator pays the ALT
   * rent once (~0.0084 SOL); every complete thereafter reuses it.
   */
  async setupCompleteLookupTable(chainId: number): Promise<Address> {
    const accounts = await this.completeStaticAltAccounts(chainId);
    const { lut } = await createAndWarmLookupTable(
      this.provider,
      chainId,
      accounts
    );
    return lut;
  }

  // --- Standalone subscription-hook branches ---

  private async setBudgetViaSubscriptionHook(
    chainId: number,
    params: SetBudgetParams,
    s: {
      signer: SolanaSigner;
      jobPda: Address;
      clientAddress: Address;
      providerAddress: Address;
      mintAddress: Address;
      /** Caller-encoded 16-byte terms, used when subscriptionTerms is absent. */
      rawOptParams: Uint8Array;
    }
  ): Promise<PreparedSolanaTx> {
    const sctx = subscriptionContext(chainId);
    const terms = params.subscriptionTerms
      ? {
          durationSecs: params.subscriptionTerms.duration,
          packageId: params.subscriptionTerms.packageId,
        }
      : null;
    const optParams = terms
      ? encodeSubParams(terms.durationSecs, terms.packageId)
      : s.rawOptParams;

    // sub_expiry activation (complete: core -> subHook -> subState -> create)
    // sits at CPI height 4 — invisible to the paymaster prefund. proposed_terms
    // is height 3 on this path and already prefunded, so only sub_expiry needs
    // pre-creating. duration 0 is the SDK's "no real subscription" signal
    // (before_action skips proposing) — skip pre-create for it too.
    const effectiveTerms = terms ?? decodeSubParams(s.rawOptParams);
    const subExpiryPackageId =
      effectiveTerms && effectiveTerms.durationSecs > 0n ? effectiveTerms.packageId : null;
    const hookRentPreCreated = await this.preCreateHookRentPdas(
      chainId,
      { fundHook: null, subHook: sctx.subHook, subState: sctx.subState },
      {
        signer: s.signer,
        jobPda: s.jobPda,
        clientAddress: s.clientAddress,
        providerAddress: s.providerAddress,
        fundRequestIntent: false,
        escrowIntent: false,
        proposedTerms: false,
        subExpiryPackageId,
      }
    );

    const extraAccounts = await buildSubSetBudgetAccounts(sctx, {
      jobPda: s.jobPda,
      seller: s.signer.address,
      clientAddress: s.clientAddress,
      terms,
    });

    const ix = getSetBudgetInstruction(
      {
        caller: s.signer,
        job: s.jobPda,
        acpState: await this.deriveAcpStatePda(chainId),
        amount: params.amount,
        hookProgram: sctx.subHook,
        hookWhitelist: await this.deriveHookWhitelistPda(chainId, sctx.subHook),
        optParams,
      },
      { programAddress: this.programAddress(chainId) }
    );

    const prepared = this.wrapMany(chainId, [
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
    if (hookRentPreCreated) {
      prepared.sendOptions = { ...prepared.sendOptions, hookRentPreCreated: true };
    }
    return prepared;
  }

  private async fundViaSubscriptionHook(
    chainId: number,
    params: FundParams,
    s: {
      signer: SolanaSigner;
      jobPda: Address;
      job: Awaited<ReturnType<typeof fetchJob>>;
      mintAddress: Address;
      vaultPda: Address;
      clientAta: Address;
      vaultAuthorityPda: Address;
      createClientAtaIx: SolanaInstructionLike;
    }
  ): Promise<PreparedSolanaTx> {
    const sctx = subscriptionContext(chainId);
    const rpc = this.provider.getRpc(chainId);

    // Echo the on-chain proposed terms — that IS the client's consent.
    // No terms means an empty confirmation (the hook accepts duration 0).
    const terms = await fetchProposedTerms(
      rpc,
      sctx.subHook,
      s.jobPda,
      ACP_COMMITMENT
    );
    const optParams = terms
      ? encodeSubParams(terms.duration, terms.packageId)
      : EMPTY_OPT_PARAMS;

    // The subscription hook never pulls tokens, so no hook delegate.
    const ix = getFundInstruction(
      {
        client: s.signer,
        acpState: await this.deriveAcpStatePda(chainId),
        job: s.jobPda,
        clientTokenAccount: s.clientAta,
        vault: s.vaultPda,
        vaultAuthority: s.vaultAuthorityPda,
        mint: s.mintAddress,
        hookProgram: sctx.subHook,
        hookWhitelist: await this.deriveHookWhitelistPda(chainId, sctx.subHook),
        expectedBudget: params.expectedBudget,
        optParams,
      },
      { programAddress: this.programAddress(chainId) }
    );

    return this.wrapMany(chainId, [
      s.createClientAtaIx,
      {
        programAddress: ix.programAddress,
        accounts: [
          ...ix.accounts,
          ...(await buildSubFundAccounts(sctx, s.jobPda)),
        ],
        data: ix.data as Uint8Array,
      },
    ]);
  }

  /**
   * submit on a standalone subscription job. With an evaluator the hook
   * merely validates the caller. Without one the core auto-completes in the
   * same instruction (EVM parity), which fires the hook's after-Complete —
   * the activation payer must sign, and the PROVIDER IS this transaction's
   * signer, so no second signature is needed. Per-action mode splits
   * the appended accounts between the Submit and Complete hook calls.
   */
  private async submitViaSubscriptionHook(
    chainId: number,
    params: SubmitParams,
    s: {
      signer: SolanaSigner;
      jobPda: Address;
      job: Awaited<ReturnType<typeof fetchJob>>;
      deliverableBytes: Uint8Array;
    }
  ): Promise<PreparedSolanaTx> {
    const sctx = subscriptionContext(chainId);
    const rpc = this.provider.getRpc(chainId);
    const job = s.job;
    const hasEvaluator = job.data.evaluator !== DEFAULT_PUBKEY;
    const isFunded = job.data.budgetAmount > 0n;

    let vaultAccounts: Record<string, Address> = {};
    const preIxs: SolanaInstructionLike[] = [];
    if (isFunded) {
      const acpStatePda = await this.deriveAcpStatePda(chainId);
      const acpState = await fetchAcpState(rpc, acpStatePda, {
        commitment: ACP_COMMITMENT,
      });
      const vaultAuthorityPda = await this.deriveVaultAuthorityPda(
        chainId,
        s.jobPda
      );
      const vaultPda = await this.deriveVaultPda(chainId, s.jobPda);
      const mintAddress = await this.fetchVaultMint(chainId, vaultPda);
      if (!mintAddress) {
        throw new Error(
          `submit: vault ${vaultPda} not found for a funded job (budget > 0); ` +
            `fund() should have created it.`
        );
      }
      const providerAta = await this.deriveAta(s.signer.address, mintAddress);
      const treasuryAta = await this.deriveAta(
        acpState.data.platformTreasury,
        mintAddress
      );
      preIxs.push(
        this.buildCreateAtaIdempotentIx(
          s.signer.address,
          providerAta,
          s.signer.address,
          mintAddress
        ),
        this.buildCreateAtaIdempotentIx(
          s.signer.address,
          treasuryAta,
          acpState.data.platformTreasury,
          mintAddress
        )
      );
      vaultAccounts = {
        vault: vaultPda,
        vaultAuthority: vaultAuthorityPda,
        providerTokenAccount: providerAta,
        treasuryTokenAccount: treasuryAta,
        sponsor: acpState.data.sponsor,
      };
    }

    const submitSlice = await buildSubSubmitAccounts(sctx, s.jobPda);
    const extraAccounts: SolanaInstructionLike["accounts"] = [...submitSlice];
    let completeOptParams: Uint8Array = EMPTY_OPT_PARAMS;
    let hookRentPreCreated = false;
    if (!hasEvaluator) {
      const terms = await fetchProposedTerms(
        rpc,
        sctx.subHook,
        s.jobPda,
        ACP_COMMITMENT
      );
      // No-evaluator submit auto-completes: sub_expiry activation fires inside
      // this tx at CPI height 4, invisible to the prefund. Fallback pre-create
      // when setBudget did not already do it (existing account — live or
      // pre-created — already carries its rent).
      if (terms) {
        const subExpiry = await subExpiryPda(
          sctx.subState,
          job.data.client,
          job.data.provider,
          terms.packageId
        );
        const existing = await rpc
          .getAccountInfo(subExpiry, { encoding: "base64" })
          .send();
        if (existing.value !== null) {
          hookRentPreCreated = true;
        } else {
          hookRentPreCreated = await this.preCreateHookRentPdas(
            chainId,
            { fundHook: null, subHook: sctx.subHook, subState: sctx.subState },
            {
              signer: s.signer,
              jobPda: s.jobPda,
              clientAddress: job.data.client,
              providerAddress: job.data.provider,
              fundRequestIntent: false,
              escrowIntent: false,
              proposedTerms: false,
              subExpiryPackageId: terms.packageId,
            }
          );
        }
      }
      const completeSlice = await buildSubCompleteAccounts(sctx, {
        jobPda: s.jobPda,
        provider: s.signer.address,
        clientAddress: job.data.client,
        packageId: terms ? terms.packageId : null,
      });
      extraAccounts.push(...completeSlice.accounts);
      const submitCount = submitSlice.length;
      completeOptParams = new Uint8Array([
        submitCount & 0xff,
        (submitCount >> 8) & 0xff,
      ]);
    }

    const ix = await getSubmitInstructionAsync(
      {
        provider: s.signer,
        job: s.jobPda,
        acpState: await this.deriveAcpStatePda(chainId),
        deliverable: s.deliverableBytes,
        hookProgram: sctx.subHook,
        hookWhitelist: await this.deriveHookWhitelistPda(chainId, sctx.subHook),
        ...vaultAccounts,
        optParams: params.optParams
          ? hexToBytes(params.optParams)
          : EMPTY_OPT_PARAMS,
        completeOptParams,
      },
      { programAddress: this.programAddress(chainId) }
    );

    const prepared = this.wrapMany(chainId, [
      ...preIxs,
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
    if (hookRentPreCreated) {
      prepared.sendOptions = { ...prepared.sendOptions, hookRentPreCreated: true };
    }
    return prepared;
  }

  private async rejectViaSubscriptionHook(
    chainId: number,
    params: RejectParams,
    s: {
      signer: SolanaSigner;
      jobPda: Address;
      job: Awaited<ReturnType<typeof fetchJob>>;
      reasonBytes: Uint8Array;
      vault: Address | undefined;
      vaultAuthority: Address | undefined;
      clientTokenAccount: Address | undefined;
      sponsor: Address;
    }
  ): Promise<PreparedSolanaTx> {
    const sctx = subscriptionContext(chainId);
    const extraAccounts = await buildSubRejectAccounts(sctx, {
      jobPda: s.jobPda,
      provider: s.job.data.provider,
    });

    const ix = await getRejectInstructionAsync(
      {
        caller: s.signer,
        job: s.jobPda,
        acpState: await this.deriveAcpStatePda(chainId),
        ...(s.vault ? { vault: s.vault } : {}),
        ...(s.vaultAuthority ? { vaultAuthority: s.vaultAuthority } : {}),
        ...(s.clientTokenAccount
          ? { clientTokenAccount: s.clientTokenAccount }
          : {}),
        sponsor: s.sponsor,
        hookProgram: sctx.subHook,
        hookWhitelist: await this.deriveHookWhitelistPda(chainId, sctx.subHook),
        reason: s.reasonBytes,
        optParams: params.optParams
          ? hexToBytes(params.optParams)
          : EMPTY_OPT_PARAMS,
      },
      { programAddress: this.programAddress(chainId) }
    );

    return this.wrapMany(chainId, [
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
  }

  /**
   * Standalone subscription complete: same activation semantics as the
   * router path but no fan-out header, no lookup table (the account set fits
   * a legacy transaction). Always sponsored, single-signer — post-F-118 no
   * co-signature is required (see completeSubscriptionJob).
   */
  private async completeSubscriptionStandalone(
    chainId: number,
    params: CompleteParams & { providerSigner?: SolanaSigner },
    s: {
      signer: SolanaSigner;
      jobPda: Address;
      job: Awaited<ReturnType<typeof fetchJob>>;
    }
  ): Promise<string> {
    const sctx = subscriptionContext(chainId);
    const rpc = this.provider.getRpc(chainId);
    const job = s.job;

    const acpStatePda = await this.deriveAcpStatePda(chainId);
    const acpState = await fetchAcpState(rpc, acpStatePda, {
      commitment: ACP_COMMITMENT,
    });
    const vaultAuthorityPda = await this.deriveVaultAuthorityPda(
      chainId,
      s.jobPda
    );
    const vaultPda = await this.deriveVaultPda(chainId, s.jobPda);
    const mintAddress =
      (await this.fetchVaultMint(chainId, vaultPda)) ?? acpState.data.paymentToken;
    const providerAta = await this.deriveAta(job.data.provider, mintAddress);
    const treasuryAta = await this.deriveAta(
      acpState.data.platformTreasury,
      mintAddress
    );

    const preIxs: SolanaInstructionLike[] = [];
    let evaluatorAta: Address | undefined;
    if (
      acpState.data.evaluatorFeeBp > 0n &&
      job.data.evaluator !== DEFAULT_PUBKEY
    ) {
      evaluatorAta = await this.deriveAta(job.data.evaluator, mintAddress);
      preIxs.push(
        this.buildCreateAtaIdempotentIx(
          s.signer.address,
          evaluatorAta,
          job.data.evaluator,
          mintAddress
        )
      );
    }

    const terms = await fetchProposedTerms(
      rpc,
      sctx.subHook,
      s.jobPda,
      ACP_COMMITMENT
    );
    const completeAccounts = await buildSubCompleteAccounts(sctx, {
      jobPda: s.jobPda,
      provider: job.data.provider,
      clientAddress: job.data.client,
      packageId: terms ? terms.packageId : null,
    });

    const ix = await getCompleteInstructionAsync(
      {
        evaluator: s.signer,
        job: s.jobPda,
        acpState: acpStatePda,
        vault: vaultPda,
        vaultAuthority: vaultAuthorityPda,
        providerTokenAccount: providerAta,
        treasuryTokenAccount: treasuryAta,
        ...(evaluatorAta ? { evaluatorTokenAccount: evaluatorAta } : {}),
        sponsor: acpState.data.sponsor,
        hookProgram: sctx.subHook,
        hookWhitelist: await this.deriveHookWhitelistPda(chainId, sctx.subHook),
        reason: encodeReasonBytes(params.reason),
        optParams: EMPTY_OPT_PARAMS,
      },
      { programAddress: this.programAddress(chainId) }
    );

    const standaloneIxs: SolanaInstructionLike[] = [
      ...preIxs,
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...completeAccounts.accounts],
        data: ix.data as Uint8Array,
      },
    ];
    // With no terms the send stays sponsored, so guard the submit→complete
    // lag (WrongStatus) the same way the router path does: confirm on our RPC
    // that the job is really Submitted before trusting the sponsor node's
    // failure.
    const { guard: standaloneGuard } = buildJobStateRetryGuard(
      this.provider.getRpc(chainId),
      this.programAddress(chainId),
      standaloneIxs,
    );
    const result = await this.provider.sendInstructions(
      chainId,
      standaloneIxs,
      {
        // requiredExtraSigner is always null post-F-118 (see
        // buildSubCompleteAccounts); this stays defensive rather than
        // hardcoded to [] so a future signer requirement needs no call-site
        // shape change.
        extraSigners:
          completeAccounts.requiredExtraSigner && params.providerSigner
            ? [params.providerSigner]
            : [],
        retryGuard: standaloneGuard,
        ...(completeAccounts.requiredExtraSigner
          ? { sponsorLookupTables: true }
          : {}),
      }
    );
    return Array.isArray(result) ? result[0]! : result;
  }

  // --- Router (multi-hook) prepared branches ---

  private async setBudgetViaRouter(
    chainId: number,
    params: SetBudgetParams,
    s: {
      signer: SolanaSigner;
      jobPda: Address;
      clientAddress: Address;
      providerAddress: Address;
      mintAddress: Address;
      fundRequestParams: Uint8Array;
    }
  ): Promise<PreparedSolanaTx> {
    const ctx = routerContext(chainId);

    // duration 0 is the SDK's own "no real subscription intended for this
    // setBudget" signal (before_action skips proposing on it) — pre-creating
    // proposed_terms/sub_expiry for it would be a wasted sponsored round-trip.
    const hasRealSubTerms =
      params.subscriptionTerms !== undefined && params.subscriptionTerms.duration > 0n;

    // Router hook-PDA creation happens at CPI height 4 where the paymaster
    // prefund cannot see it — pre-create everything this leg (and the later
    // submit/complete legs) will touch, in a direct sponsored tx.
    const hookRentPreCreated = await this.preCreateHookRentPdas(
      chainId,
      { fundHook: ctx.fundHook, subHook: ctx.subHook, subState: ctx.subState },
      {
        signer: s.signer,
        jobPda: s.jobPda,
        clientAddress: s.clientAddress,
        providerAddress: s.providerAddress,
        fundRequestIntent: s.fundRequestParams.length > 0,
        escrowIntent: true,
        proposedTerms: hasRealSubTerms,
        subExpiryPackageId: hasRealSubTerms ? params.subscriptionTerms!.packageId : null,
      }
    );

    const fanOut = await buildSetBudgetFanOut(ctx, {
      jobPda: s.jobPda,
      seller: s.signer.address,
      clientAddress: s.clientAddress,
      terms: params.subscriptionTerms
        ? {
            durationSecs: params.subscriptionTerms.duration,
            packageId: params.subscriptionTerms.packageId,
          }
        : null,
      fundRequestParams:
        s.fundRequestParams.length > 0 ? s.fundRequestParams : null,
    });

    const ix = getSetBudgetInstruction(
      {
        caller: s.signer,
        job: s.jobPda,
        acpState: await this.deriveAcpStatePda(chainId),
        amount: params.amount,
        hookProgram: ctx.router,
        hookWhitelist: await this.deriveHookWhitelistPda(chainId, ctx.router),
        optParams: fanOut.optParams,
      },
      { programAddress: this.programAddress(chainId) }
    );

    const prepared = this.wrapMany(chainId, [
      cuLimitIx(),
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...fanOut.extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
    if (hookRentPreCreated) {
      prepared.sendOptions = { ...prepared.sendOptions, hookRentPreCreated: true };
    }
    return prepared;
  }

  private async fundViaRouter(
    chainId: number,
    params: FundParams,
    s: {
      signer: SolanaSigner;
      jobPda: Address;
      job: Awaited<ReturnType<typeof fetchJob>>;
      mintAddress: Address;
      vaultPda: Address;
      clientAta: Address;
      vaultAuthorityPda: Address;
      createClientAtaIx: SolanaInstructionLike;
    }
  ): Promise<PreparedSolanaTx> {
    const ctx = routerContext(chainId);
    const rpc = this.provider.getRpc(chainId);
    const job = s.job;

    const terms = await fetchProposedTerms(
      rpc,
      ctx.subHook,
      s.jobPda,
      ACP_COMMITMENT
    );

    // ATA creations are split OUT of the fund tx into a separate sponsored
    // send (below). The router fund fan-out plus 3 idempotent ATA creates is
    // ~1264 bytes — over Solana's 1232 limit once the sponsor's fee-payer swap
    // is added, so Alchemy refuses it. Without the creates the fund tx is
    // ~1068 bytes and sponsors cleanly; the ATA-only tx sponsors on its own
    // (ATA program is sponsorable). Net: router fund is fully sponsored, buyer
    // pays no SOL.
    const ataCreateIxs: SolanaInstructionLike[] = [s.createClientAtaIx];
    const hookPreIxs: SolanaInstructionLike[] = [];
    const hookPostIxs: SolanaInstructionLike[] = [];
    let passHookDelegate = true;
    let fundIntent: {
      token: Address;
      amount: bigint;
      recipient: Address;
      fromAta: Address;
      recipientAta: Address;
    } | null = null;

    const fundRequestIntentIdPda = await this.deriveFundRequestIntentIdPda(
      ctx.fundHook,
      s.jobPda
    );
    const maybeFriid = await fetchMaybeFundRequestIntentId(
      rpc,
      fundRequestIntentIdPda,
      { commitment: ACP_COMMITMENT }
    );
    if (maybeFriid.exists && maybeFriid.data.intentId !== 0n) {
      const intentPda = await this.deriveIntentPda(
        ctx.fundHook,
        s.jobPda,
        INTENT_KIND_FUND_REQUEST
      );
      const intent = await fetchIntent(rpc, intentPda, {
        commitment: ACP_COMMITMENT,
      });
      const fromAta = await this.deriveAta(intent.data.from, intent.data.token);
      const recipientAta = await this.deriveAta(
        intent.data.recipient,
        intent.data.token
      );
      ataCreateIxs.push(
        this.buildCreateAtaIdempotentIx(
          s.signer.address,
          recipientAta,
          intent.data.recipient,
          intent.data.token
        )
      );

      // Same delegate-coverage rule as the single-hook path: the
      // core approval covers budget-mint pulls up to the budget on funded
      // jobs; anything else needs the client's Approve/Revoke bracket.
      const coreApprovalCovers =
        job.data.budgetAmount > 0n &&
        intent.data.token === s.mintAddress &&
        intent.data.amount <= job.data.budgetAmount;
      if (intent.data.amount > 0n && !coreApprovalCovers) {
        const fundHookState = await this.deriveHookStatePda(ctx.fundHook);
        hookPreIxs.push(
          this.buildApproveIx(
            fromAta,
            fundHookState,
            s.signer.address,
            intent.data.amount
          )
        );
        hookPostIxs.push(this.buildRevokeIx(fromAta, s.signer.address));
        if (intent.data.token === s.mintAddress) {
          passHookDelegate = false;
        }
      }

      fundIntent = {
        token: intent.data.token,
        amount: intent.data.amount,
        recipient: intent.data.recipient,
        fromAta,
        recipientAta,
      };
    }

    const fanOut = await buildFundFanOut(ctx, {
      jobPda: s.jobPda,
      proposedTerms: terms
        ? { duration: terms.duration, packageId: terms.packageId }
        : null,
      fundIntent,
    });

    const ix = getFundInstruction(
      {
        client: s.signer,
        acpState: await this.deriveAcpStatePda(chainId),
        job: s.jobPda,
        clientTokenAccount: s.clientAta,
        vault: s.vaultPda,
        vaultAuthority: s.vaultAuthorityPda,
        mint: s.mintAddress,
        hookProgram: ctx.router,
        hookWhitelist: await this.deriveHookWhitelistPda(chainId, ctx.router),
        // The delegate that pulls tokens is the FUND HOOK's hook_state, not
        // the router; its own ACP whitelist validates it.
        ...(passHookDelegate
          ? {
              hookDelegate: await this.deriveHookStatePda(ctx.fundHook),
              delegateWhitelist: await this.deriveHookWhitelistPda(
                chainId,
                ctx.fundHook
              ),
            }
          : {}),
        expectedBudget: params.expectedBudget,
        optParams: fanOut.optParams,
      },
      { programAddress: this.programAddress(chainId) }
    );

    // Create the ATAs FIRST, in their own sponsored (+ prefund) tx, so the
    // fund tx below carries no account creations and fits under the sponsor's
    // size limit. Idempotent, so a re-send (e.g. the caller's reprepare retry)
    // is safe. This is a broadcast side-effect at prepare time — the same
    // eager pattern completeSubscriptionJob uses; the returned fund tx itself
    // is still an ordinary prepared tx.
    await this.execute(chainId, ataCreateIxs);

    const prepared = this.wrapMany(chainId, [
      cuLimitIx(),
      ...hookPreIxs,
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...fanOut.extraAccounts],
        data: ix.data as Uint8Array,
      },
      ...hookPostIxs,
    ]);

    // post_fund's account list never includes SYSTEM_PROGRAM_ID (see
    // buildFundFanOut) — unlike setBudget/submit/complete, it only writes to
    // hook PDAs (intent, proposed_terms) that setBudget already created, so
    // the fund leg structurally never creates a hook PDA at CPI depth 4. A
    // zero prefund here is therefore always the expected outcome, not
    // something contingent on a pre-preCreate SDK — set the flag
    // unconditionally so the router zero-prefund warning stays silent.
    prepared.sendOptions = { ...prepared.sendOptions, hookRentPreCreated: true };

    const persistentAlt = MULTI_HOOK_COMPLETE_ALT_ADDRESSES[chainId];
    if (persistentAlt) {
      // Sponsored ALT compression applies to EVERY router fund, not just a
      // bracketed one: the ATA creates are already split out (above), and an
      // uncompressed router fund still measures close enough to 1232 bytes
      // that Alchemy's own rent-prefund augmentation can push it over, which
      // fails the tx with no on-chain trace (never broadcast) and leaves the
      // acting wallet's ATA-create tx unsponsored. Compressing the static
      // accounts reclaims headroom regardless of whether a bracket is present.
      prepared.sendOptions = {
        ...prepared.sendOptions,
        lookupTables: {
          [persistentAlt]: await this.completeStaticAltAccounts(chainId),
        },
        sponsorLookupTables: true,
      };
    }
    return prepared;
  }

  private async submitViaRouter(
    chainId: number,
    params: SubmitParams,
    s: {
      signer: SolanaSigner;
      jobPda: Address;
      job: Awaited<ReturnType<typeof fetchJob>>;
      deliverableBytes: Uint8Array;
    }
  ): Promise<PreparedSolanaTx> {
    const ctx = routerContext(chainId);
    const rpc = this.provider.getRpc(chainId);
    const job = s.job;

    if (job.data.evaluator === DEFAULT_PUBKEY) {
      throw new Error(
        "Multi-hook (router) jobs require an evaluator: the no-evaluator " +
          "auto-complete path is not wired through the router fan-out."
      );
    }
    // A zero-budget job (an active-subscription renewal, which the sub hook
    // forces to amount == 0 — R-H2/SA-6) is submittable: the core allows
    // `Open|Funded with budget == 0` and the fund hook's
    // post_submit no-escrow path is valid because router jobs always have an
    // evaluator. There is nothing to stake, so this takes
    // the no-escrow submit below — the same fan-out R-H8 exercises. Matches EVM
    // (AgenticCommerceV3.submit's explicit `budget == 0` carve-out) and the
    // standalone sub path (submitViaSubscriptionHook).

    const acpStatePda = await this.deriveAcpStatePda(chainId);
    const acpState = await fetchAcpState(rpc, acpStatePda, {
      commitment: ACP_COMMITMENT,
    });
    const vaultAuthorityPda = await this.deriveVaultAuthorityPda(
      chainId,
      s.jobPda
    );
    const vaultPda = await this.deriveVaultPda(chainId, s.jobPda);
    // A zero-budget router job (see above) never had a vault created —
    // fetchVaultMint then returns null and acp_state.payment_token stands in,
    // matching the old budgetMint.None fallback.
    const mintAddress =
      (await this.fetchVaultMint(chainId, vaultPda)) ?? acpState.data.paymentToken;
    const providerAta = await this.deriveAta(s.signer.address, mintAddress);
    const treasuryAta = await this.deriveAta(
      acpState.data.platformTreasury,
      mintAddress
    );

    // ATA creates are collected separately so a foreign-mint stake can split
    // them out of the submit tx (see the routing at the return).
    const ataCreateIxs: SolanaInstructionLike[] = [
      this.buildCreateAtaIdempotentIx(
        s.signer.address,
        providerAta,
        s.signer.address,
        mintAddress
      ),
      this.buildCreateAtaIdempotentIx(
        s.signer.address,
        treasuryAta,
        acpState.data.platformTreasury,
        mintAddress
      ),
    ];
    const preIxs: SolanaInstructionLike[] = [];
    const postIxs: SolanaInstructionLike[] = [];
    // A foreign-mint stake adds an Approve/Revoke bracket the budget-mint path
    // skips, overflowing the 1232-byte sponsored submit. Kept fully sponsored:
    // the ATA creates are split out to an eager sponsored tx (so Alchemy no
    // longer rent-prefunds them inside the submit) AND the submit compresses its
    // static accounts against the persistent complete ALT.
    let foreignEscrowBracket = false;
    // An over-budget budget-mint stake must submit delegate-less (the same
    // shape as the fund path): otherwise the core's budget_amount approve/revoke around the
    // fan-out clamps the pull. Set when we bracket such a stake below; consumed
    // at the submit instruction build.
    let submitDelegateLess = false;

    // Escrow proposal: default full budget in the budget mint; callers
    // override via params.optParams ("0x" proposes no escrow — allowed here
    // because router jobs always have an evaluator). A zero-budget job has
    // nothing to stake, so it defaults to no escrow (the fund hook's
    // no-escrow-with-evaluator path) rather than a pointless zero-amount stake.
    const submitOptBytes =
      params.optParams !== undefined
        ? hexToBytes(params.optParams)
        : job.data.budgetAmount === 0n
          ? EMPTY_OPT_PARAMS
          : hexToBytes(
              encodeFundTransferSubmitOptParams(
                chainId,
                mintAddress,
                job.data.budgetAmount
              )
            );
    const escrowProposal = decodeSolanaEscrowOptParams(submitOptBytes);

    let escrow: {
      token: Address;
      amount: bigint;
      providerAta: Address;
      escrowVault: Address;
      escrowAuthority: Address;
    } | null = null;
    if (escrowProposal !== null) {
      const escrowToken = escrowProposal.token as Address;
      const escrowAuthorityPda = await this.deriveEscrowAuthorityPda(
        ctx.fundHook,
        s.jobPda
      );
      const escrowVault = await this.deriveAta(escrowAuthorityPda, escrowToken);
      const providerEscrowAta = await this.deriveAta(
        s.signer.address,
        escrowToken
      );
      // Escrow vault stays INLINE — the hook validates + transfers into it in
      // the same submit tx, so it must exist there; splitting it out races the
      // sponsor node (InvalidEscrowVault). Only the budget-mint ATAs above are
      // split (they aren't touched by the hook, just referenced).
      preIxs.push(
        this.buildCreateAtaIdempotentIx(
          s.signer.address,
          escrowVault,
          escrowAuthorityPda,
          escrowToken
        )
      );

      // Delegate coverage: the core approves the fund hook's
      // delegate on the budget-mint account, bounded to budget_amount. A
      // foreign-mint stake, or a budget-mint stake ABOVE budget (the hook's own
      // cap is gone), can't ride it and needs the provider's own Approve/Revoke
      // bracket instead.
      const overBudgetBudgetMint =
        escrowToken === mintAddress &&
        escrowProposal.amount > job.data.budgetAmount;
      const coreApprovalCovers =
        escrowToken === mintAddress && !overBudgetBudgetMint;
      // Router jobs always have an evaluator (asserted above), so an over-budget
      // budget-mint bracket must go delegate-less to survive the core's pull.
      submitDelegateLess = overBudgetBudgetMint;
      if (escrowProposal.amount > 0n && !coreApprovalCovers) {
        const fundHookState = await this.deriveHookStatePda(ctx.fundHook);
        preIxs.push(
          this.buildApproveIx(
            providerEscrowAta,
            fundHookState,
            s.signer.address,
            escrowProposal.amount
          )
        );
        postIxs.push(this.buildRevokeIx(providerEscrowAta, s.signer.address));
        // A bracket (foreign OR over-budget budget-mint) adds instructions that
        // push the sponsored submit past 1232 bytes; split the ATA creates and
        // ALT-compress exactly as the foreign path does.
        foreignEscrowBracket = true;
      }

      escrow = {
        token: escrowToken,
        amount: escrowProposal.amount,
        providerAta: providerEscrowAta,
        escrowVault,
        escrowAuthority: escrowAuthorityPda,
      };
    }

    // Fallback pre-create for the escrow intent (kind 1): covers jobs whose
    // setBudget ran on an older SDK or whose eager pre-create tx failed. When
    // the intent PDA already exists (pre-created or live), the zero prefund on
    // the submit tx is expected — suppress the warning either way.
    let hookRentPreCreated = false;
    if (escrow !== null) {
      const escrowIntentPda = await this.deriveIntentPda(
        ctx.fundHook,
        s.jobPda,
        1
      );
      const existing = await this.provider
        .getRpc(chainId)
        .getAccountInfo(escrowIntentPda, { encoding: "base64" })
        .send();
      if (existing.value !== null) {
        hookRentPreCreated = true;
      } else {
        hookRentPreCreated = await this.preCreateHookRentPdas(
          chainId,
          { fundHook: ctx.fundHook, subHook: ctx.subHook, subState: ctx.subState },
          {
            signer: s.signer,
            jobPda: s.jobPda,
            clientAddress: job.data.client,
            providerAddress: job.data.provider,
            fundRequestIntent: false,
            escrowIntent: true,
            proposedTerms: false,
            subExpiryPackageId: null,
          }
        );
      }
    }

    const fanOut = await buildSubmitFanOut(ctx, {
      jobPda: s.jobPda,
      seller: s.signer.address,
      escrow,
    });

    const ix = await getSubmitInstructionAsync(
      {
        provider: s.signer,
        job: s.jobPda,
        acpState: acpStatePda,
        vault: vaultPda,
        vaultAuthority: vaultAuthorityPda,
        providerTokenAccount: providerAta,
        treasuryTokenAccount: treasuryAta,
        sponsor: acpState.data.sponsor,
        deliverable: s.deliverableBytes,
        hookProgram: ctx.router,
        hookWhitelist: await this.deriveHookWhitelistPda(chainId, ctx.router),
        // The delegate that pulls tokens is the FUND HOOK's hook_state, not the
        // router. Dropped for an over-budget budget-mint stake so the core skips
        // its budget_amount approve/revoke and the provider's own bracket
        // governs (see submitDelegateLess above; fund parity).
        ...(submitDelegateLess
          ? {}
          : {
              hookDelegate: await this.deriveHookStatePda(ctx.fundHook),
              providerHookTokenAccount: providerAta,
              delegateWhitelist: await this.deriveHookWhitelistPda(
                chainId,
                ctx.fundHook
              ),
            }),
        optParams: fanOut.optParams,
        completeOptParams: EMPTY_OPT_PARAMS,
      },
      { programAddress: this.programAddress(chainId) }
    );

    const persistentAlt = MULTI_HOOK_COMPLETE_ALT_ADDRESSES[chainId];
    const splitAtas = foreignEscrowBracket && !!persistentAlt;
    if (splitAtas) {
      // Eager, sponsored: create the ATAs in their own tx so Alchemy stops
      // rent-prefunding them inside the submit (the prefund is what re-inflated
      // the compressed submit past 1232). Provider pays $0 — this tx is small
      // and sponsored like any other ATA create.
      await this.execute(chainId, ataCreateIxs);
    } else {
      // Budget-mint (fits): keep the ATA creates inline, unchanged.
      preIxs.unshift(...ataCreateIxs);
    }

    const prepared = this.wrapMany(chainId, [
      cuLimitIx(),
      ...preIxs,
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...fanOut.extraAccounts],
        data: ix.data as Uint8Array,
      },
      ...postIxs,
    ]);

    if (persistentAlt) {
      // Sponsored ALT compression applies to EVERY router submit, not just a
      // bracketed one: an uncompressed router submit measures close enough to
      // 1232 bytes that Alchemy's own rent-prefund augmentation can push it
      // over, which fails the tx with no on-chain trace (never broadcast) and
      // leaves the inline ATA creates unsponsored. Compressing the static
      // accounts reclaims headroom regardless of whether a bracket is present.
      prepared.sendOptions = {
        lookupTables: {
          [persistentAlt]: await this.completeStaticAltAccounts(chainId),
        },
        sponsorLookupTables: true,
      };
    }
    if (hookRentPreCreated) {
      prepared.sendOptions = { ...prepared.sendOptions, hookRentPreCreated: true };
    }
    return prepared;
  }

  private async rejectViaRouter(
    chainId: number,
    params: RejectParams,
    s: {
      signer: SolanaSigner;
      jobPda: Address;
      job: Awaited<ReturnType<typeof fetchJob>>;
      reasonBytes: Uint8Array;
      vault: Address | undefined;
      vaultAuthority: Address | undefined;
      clientTokenAccount: Address | undefined;
      sponsor: Address;
    }
  ): Promise<PreparedSolanaTx> {
    const ctx = routerContext(chainId);
    const rpc = this.provider.getRpc(chainId);
    const job = s.job;

    let escrow: {
      providerAta: Address;
      escrowVault: Address;
      escrowAuthority: Address;
    } | null = null;
    const provEscrowIntentIdPda = await this.deriveProviderEscrowIntentIdPda(
      ctx.fundHook,
      s.jobPda
    );
    const maybePeii = await fetchMaybeProviderEscrowIntentId(
      rpc,
      provEscrowIntentIdPda,
      { commitment: ACP_COMMITMENT }
    );
    // A pre-created (zeroed) map means no escrow was ever proposed —
    // intentId 0 is the unset sentinel, not a live escrow.
    if (maybePeii.exists && maybePeii.data.intentId !== 0n) {
      const escrowIntentPda = await this.deriveIntentPda(
        ctx.fundHook,
        s.jobPda,
        INTENT_KIND_ESCROW
      );
      const intent = await fetchIntent(rpc, escrowIntentPda, {
        commitment: ACP_COMMITMENT,
      });
      const escrowAuthorityPda = await this.deriveEscrowAuthorityPda(
        ctx.fundHook,
        s.jobPda
      );
      escrow = {
        providerAta: await this.deriveAta(intent.data.from, intent.data.token),
        escrowVault: await this.deriveAta(escrowAuthorityPda, intent.data.token),
        escrowAuthority: escrowAuthorityPda,
      };
    }

    const fanOut = await buildRejectFanOut(ctx, {
      jobPda: s.jobPda,
      provider: job.data.provider,
      escrow,
    });

    const ix = await getRejectInstructionAsync(
      {
        caller: s.signer,
        job: s.jobPda,
        acpState: await this.deriveAcpStatePda(chainId),
        ...(s.vault ? { vault: s.vault } : {}),
        ...(s.vaultAuthority ? { vaultAuthority: s.vaultAuthority } : {}),
        ...(s.clientTokenAccount
          ? { clientTokenAccount: s.clientTokenAccount }
          : {}),
        sponsor: s.sponsor,
        hookProgram: ctx.router,
        hookWhitelist: await this.deriveHookWhitelistPda(chainId, ctx.router),
        reason: s.reasonBytes,
        optParams: fanOut.optParams,
      },
      { programAddress: this.programAddress(chainId) }
    );

    // The reject fan-out (both hooks' before+after actions + token transfers)
    // needs > 200k CU, so cuLimitIx is required. That plus the ~50-account set
    // makes the tx ~1 byte over the sponsored size limit, so compress it
    // against the persistent complete lookup table (reject's static accounts
    // are a subset of complete's) — keeps reject sponsored and the evaluator
    // pays no SOL. Falls back to a plain (too-large-for-sponsor) tx only when
    // no persistent table is configured.
    const prepared = this.wrapMany(chainId, [
      cuLimitIx(),
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...fanOut.extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
    // post_reject's account list never includes SYSTEM_PROGRAM_ID (see
    // buildRejectFanOut) — it CLOSES proposed_terms and refunds rent, the
    // inverse of creation, so the reject leg structurally never creates a
    // hook PDA at CPI depth 4. A zero prefund here is always the expected
    // outcome; set the flag unconditionally so the router zero-prefund
    // warning stays silent (same reasoning as fundViaRouter).
    prepared.sendOptions = { ...prepared.sendOptions, hookRentPreCreated: true };

    const persistentAlt = MULTI_HOOK_COMPLETE_ALT_ADDRESSES[chainId];
    if (persistentAlt) {
      prepared.sendOptions = {
        ...prepared.sendOptions,
        lookupTables: {
          [persistentAlt]: await this.completeStaticAltAccounts(chainId),
        },
        sponsorLookupTables: true,
      };
    }
    return prepared;
  }

  // --- Private helpers ---

  /**
   * Pre-create hook-rent PDAs in their own DIRECT sponsored transaction so the
   * paymaster's `prefundRent` sees the createAccounts at CPI height 2 (the
   * router/sub-state paths create them at height 4+, invisible to the
   * prefund). Idempotent on-chain; payer must be the job's provider.
   *
   * Returns true when the pre-create tx confirmed (callers then set
   * `sendOptions.hookRentPreCreated` so the zero-prefund warning is
   * suppressed). Failure is non-fatal: the lifecycle handlers still create
   * the accounts themselves, the provider just pays the rent — the prior
   * status quo.
   */
  private async preCreateHookRentPdas(
    chainId: number,
    programs: { fundHook: Address | null; subHook: Address; subState: Address },
    args: {
      signer: SolanaSigner;
      jobPda: Address;
      clientAddress: Address;
      providerAddress: Address;
      fundRequestIntent: boolean;
      escrowIntent: boolean;
      proposedTerms: boolean;
      subExpiryPackageId: bigint | null;
    }
  ): Promise<boolean> {
    // The on-chain pre_create_* handlers hard-require payer == job.provider, and
    // setBudget/submit (the only legs that pre-create) are provider-only ACP
    // operations. A non-provider signer here is a caller error, not a runtime
    // condition to degrade past: fail loud instead of silently stranding the
    // hook rent on the provider at CPI depth 4. This throw sits BEFORE the try
    // so it propagates to the caller; only genuine execute/network failures
    // below are caught and degraded gracefully.
    if (args.signer.address !== args.providerAddress) {
      throw new Error(
        `[pre-create] hook-PDA pre-create requires the job provider as signer ` +
          `(on-chain payer == job.provider); setBudget/submit are provider-only. ` +
          `Got signer ${args.signer.address}, provider ${args.providerAddress}.`
      );
    }
    try {
      // Existence-prune every target first: an account that already exists
      // (live OR previously pre-created) makes pre-create a pure on-chain
      // no-op (Anchor init_if_needed / is_unset both pass through), so
      // attempting it again only costs an unnecessary sponsored round-trip —
      // and, on a leg immediately followed by fund/submit, extra exposure to
      // sponsor-node simulation lag on THAT next leg. Skip anything already
      // there; report "pre-created" (true) whenever nothing is left to do,
      // since the caller's job (a zero prefund being expected) is satisfied
      // either way.
      const rpc = this.provider.getRpc(chainId);
      const exists = async (addr: Address) =>
        (await rpc.getAccountInfo(addr, { encoding: "base64" }).send()).value !== null;

      let fundRequestIntent = args.fundRequestIntent;
      let escrowIntent = args.escrowIntent;
      let proposedTerms = args.proposedTerms;
      let subExpiryPackageId = args.subExpiryPackageId;
      let anyPreexisting = false;

      if (fundRequestIntent || escrowIntent) {
        if (!programs.fundHook) {
          throw new Error("fundHook address is required to pre-create intent PDAs");
        }
        if (fundRequestIntent) {
          const already = await exists(await intentPda(programs.fundHook, args.jobPda, INTENT_KIND_FUND_REQUEST));
          if (already) { fundRequestIntent = false; anyPreexisting = true; }
        }
        if (escrowIntent) {
          const already = await exists(await intentPda(programs.fundHook, args.jobPda, INTENT_KIND_ESCROW));
          if (already) { escrowIntent = false; anyPreexisting = true; }
        }
      }
      // before_action skips proposing entirely when the target subscription
      // is ALREADY ACTIVE (current_expiry > now) — it never writes real
      // content into this job's proposed_terms, only leaving our pre-created
      // account zeroed forever. after_action's own "does a proposal exist"
      // check only tests non-empty-data + correct owner (not the zero
      // discriminator is_unset() uses), so a permanently-zeroed pre-created
      // account passes that check and then fails to deserialize as
      // ProposedTerms — InvalidJob on the very next leg (fund/submit).
      // Mirror the on-chain skip condition here so we never create a
      // proposed_terms PDA that will never be filled in.
      let subscriptionAlreadyActive = false;
      if (subExpiryPackageId !== null) {
        const subExpiryAddr = await subExpiryPda(
          programs.subState,
          args.clientAddress,
          args.providerAddress,
          subExpiryPackageId,
        );
        const acct = await fetchMaybeSubscriptionExpiry(rpc, subExpiryAddr);
        if (acct.exists) {
          anyPreexisting = true;
          subExpiryPackageId = null;
          if (acct.data.expiry > BigInt(Math.floor(Date.now() / 1000))) {
            subscriptionAlreadyActive = true;
          }
        }
      }
      if (proposedTerms) {
        if (subscriptionAlreadyActive) {
          proposedTerms = false;
        } else {
          const already = await exists(await proposedTermsPda(programs.subHook, args.jobPda));
          if (already) { proposedTerms = false; anyPreexisting = true; }
        }
      }

      const ixs = await buildPreCreateHookPdaIxs({
        ...programs,
        payer: args.signer,
        jobPda: args.jobPda,
        clientAddress: args.clientAddress,
        providerAddress: args.providerAddress,
        fundRequestIntent,
        escrowIntent,
        proposedTerms,
        subExpiryPackageId,
      });
      if (ixs.length === 0) return anyPreexisting;
      await this.execute(chainId, ixs);
      return true;
    } catch (e) {
      console.warn(
        `[pre-create] hook-PDA pre-create failed (${(e as Error)?.message ?? e}); ` +
          "continuing — rents fall back to the provider wallet at CPI depth 4"
      );
      return false;
    }
  }

  private wrapMany(
    chainId: number,
    instructions: SolanaInstructionLike[]
  ): PreparedSolanaTx {
    return {
      tx: instructions,
      chain: "solana",
      // Fallback keeps synthetic test chain ids (e.g. 901) working.
      network: SOLANA_CHAIN_ID_CLUSTERS[chainId] ?? "devnet",
    };
  }

  private async deriveAcpStatePda(chainId: number): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.programAddress(chainId),
      seeds: [getUtf8Encoder().encode("acp_state")],
    });
    return pda;
  }

  private async deriveJobPda(
    chainId: number,
    client: Address,
    seed: bigint
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.programAddress(chainId),
      seeds: [
        getUtf8Encoder().encode("job"),
        getAddressEncoder().encode(client),
        getU64Encoder().encode(seed),
      ],
    });
    return pda;
  }

  private async deriveHookStatePda(hookProgram: Address): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: hookProgram,
      seeds: [getUtf8Encoder().encode("hook_state")],
    });
    return pda;
  }

  private async deriveHookWhitelistPda(
    chainId: number,
    hookProgram: Address
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.programAddress(chainId),
      seeds: [
        getUtf8Encoder().encode("hook_whitelist"),
        getAddressEncoder().encode(hookProgram),
      ],
    });
    return pda;
  }

  private async deriveHookDelegatePda(hookProgram: Address): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: hookProgram,
      seeds: [getUtf8Encoder().encode("hook_state")],
    });
    return pda;
  }

  /**
   * Intent PDAs are job-scoped — ["intent", job_key, kind] with kind
   * 0 = fund-request, 1 = escrow, where job_key is the job account's own
   * address. Derived from the job's address alone, so prepare never predicts
   * the hook's global intent counter (predicting it raced whenever two
   * intent-creating transactions were in flight).
   */
  private async deriveIntentPda(
    hookProgram: Address,
    job: Address,
    kind: typeof INTENT_KIND_FUND_REQUEST | typeof INTENT_KIND_ESCROW
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: hookProgram,
      seeds: [
        getUtf8Encoder().encode("intent"),
        getAddressEncoder().encode(job),
        new Uint8Array([kind]),
      ],
    });
    return pda;
  }

  private async deriveFundRequestIntentIdPda(
    hookProgram: Address,
    job: Address
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: hookProgram,
      seeds: [
        getUtf8Encoder().encode("fund_request_intent_id"),
        getAddressEncoder().encode(job),
      ],
    });
    return pda;
  }

  private async deriveProviderEscrowIntentIdPda(
    hookProgram: Address,
    job: Address
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: hookProgram,
      seeds: [
        getUtf8Encoder().encode("provider_escrow_intent_id"),
        getAddressEncoder().encode(job),
      ],
    });
    return pda;
  }

  private async deriveEscrowAuthorityPda(
    hookProgram: Address,
    job: Address
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: hookProgram,
      seeds: [
        getUtf8Encoder().encode("escrow_authority"),
        getAddressEncoder().encode(job),
      ],
    });
    return pda;
  }

  private async deriveVaultAuthorityPda(
    chainId: number,
    jobPda: Address
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.programAddress(chainId),
      seeds: [
        getUtf8Encoder().encode("vault_authority"),
        getAddressEncoder().encode(jobPda),
      ],
    });
    return pda;
  }

  /**
   * The per-job escrow token account, program-derived so its ADDRESS is
   * unique to the job. `vault.mint` is authoritative — there is exactly one
   * vault per job and a token account's mint is immutable once initialized —
   * which is what makes reading the mint back from the fetched vault safe on
   * every exit path (submit/complete/reject/claimRefund), instead of trusting
   * a caller-supplied or separately-stored mint.
   */
  private async deriveVaultPda(chainId: number, jobPda: Address): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.programAddress(chainId),
      seeds: [
        getUtf8Encoder().encode("vault"),
        getAddressEncoder().encode(jobPda),
      ],
    });
    return pda;
  }

  /**
   * Reads the mint straight off the vault's own bytes rather than decoding the
   * full SPL token account: no generated fetcher exists for it here (this SDK
   * has no @solana-program/token dependency), and the mint is the first 32
   * bytes of the standard Token Program account layout — the same raw-decode
   * convention getTokenDecimals already uses for a mint account.
   *
   * Returns null when the vault does not exist (a zero-budget or not-yet-
   * funded job), which every caller must treat as "no vault, no mint" rather
   * than an error.
   */
  private async fetchVaultMint(
    chainId: number,
    vaultPda: Address
  ): Promise<Address | null> {
    const rpc = this.provider.getRpc(chainId);
    const accountInfo = await rpc
      .getAccountInfo(vaultPda, { encoding: "base64", commitment: ACP_COMMITMENT })
      .send();
    if (!accountInfo.value) return null;

    const data = Uint8Array.from(
      atob(accountInfo.value.data[0] as string),
      (c) => c.charCodeAt(0)
    );
    return getAddressDecoder().decode(data.subarray(0, 32));
  }

  private async deriveAta(owner: Address, mint: Address): Promise<Address> {
    const TOKEN_PROGRAM_ID =
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
    const ATA_PROGRAM_ID =
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

    const [pda] = await getProgramDerivedAddress({
      programAddress: ATA_PROGRAM_ID,
      seeds: [
        getAddressEncoder().encode(owner),
        getAddressEncoder().encode(TOKEN_PROGRAM_ID),
        getAddressEncoder().encode(mint),
      ],
    });
    return pda;
  }

  /**
   * Cache key for a job PDA. Includes the client: `jobId` (the seed passed at
   * creation) is a caller-chosen u64 that need only be unique PER CLIENT, not
   * globally — unlike the old acp_state.job_counter-derived id, two different
   * clients may legitimately pick the same value. A key without the client
   * would let one client's cache entry silently answer another client's
   * lookup.
   */
  private jobPdaCacheKey(chainId: number, client: Address, jobId: bigint): string {
    return `${chainId}:${client}:${jobId}`;
  }

  /**
   * Resolves the chain-agnostic bigint jobId (the seed passed to createJob)
   * to the job's actual Solana address. Public because the job's identity IS
   * that address — anything doing address-level work on a Solana job (PDA
   * derivation for a hook/router account, a raw account read) needs this, not
   * just internal lifecycle methods. `clientAddress` defaults to the current
   * signer, matching every other jobId-keyed method on this class: without an
   * explicit client, a job is assumed to belong to the caller's own wallet.
   */
  async resolveJobPda(
    chainId: number,
    jobId: bigint,
    clientAddress?: string
  ): Promise<Address> {
    const client = (clientAddress ??
      this.provider.getSigner().address) as Address;
    const cacheKey = this.jobPdaCacheKey(chainId, client, jobId);
    const cached = this.jobPdaCache.get(cacheKey);
    if (cached) return cached;

    const pda = await this.deriveJobPda(chainId, client, jobId);
    this.jobPdaCache.set(cacheKey, pda);
    return pda;
  }

  private buildCreateAtaIdempotentIx(
    payer: Address,
    ata: Address,
    owner: Address,
    mint: Address
  ): SolanaInstructionLike {
    const TOKEN_PROGRAM_ID =
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
    const ATA_PROGRAM_ID =
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
    const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111" as Address;

    return {
      programAddress: ATA_PROGRAM_ID,
      accounts: [
        { address: payer, role: AccountRole.WRITABLE_SIGNER },
        { address: ata, role: AccountRole.WRITABLE },
        { address: owner, role: AccountRole.READONLY },
        { address: mint, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
        { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      ],
      data: new Uint8Array([1]), // CreateIdempotent instruction index
    };
  }

  private buildApproveIx(
    source: Address,
    delegate: Address,
    owner: Address,
    amount: bigint
  ): SolanaInstructionLike {
    const TOKEN_PROGRAM_ID =
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

    const data = new Uint8Array(9);
    data[0] = 4; // Approve instruction index
    data.set(getU64Encoder().encode(amount), 1);

    return {
      programAddress: TOKEN_PROGRAM_ID,
      accounts: [
        { address: source, role: AccountRole.WRITABLE },
        { address: delegate, role: AccountRole.READONLY },
        { address: owner, role: AccountRole.READONLY_SIGNER },
      ],
      data,
    };
  }

  private buildRevokeIx(
    source: Address,
    owner: Address
  ): SolanaInstructionLike {
    const TOKEN_PROGRAM_ID =
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

    return {
      programAddress: TOKEN_PROGRAM_ID,
      accounts: [
        { address: source, role: AccountRole.WRITABLE },
        { address: owner, role: AccountRole.READONLY_SIGNER },
      ],
      data: new Uint8Array([5]), // Revoke instruction index
    };
  }
}
