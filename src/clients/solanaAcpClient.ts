import {
  type Address,
  type Signature,
  AccountRole,
  getProgramDerivedAddress,
  getAddressEncoder,
  getU64Encoder,
  fixEncoderSize,
  getUtf8Encoder,
  getBytesEncoder,
} from "@solana/kit";
import { hexToBytes, keccak256, toHex, type Hex } from "viem";
import {
  decodeSolanaEscrowOptParams,
  encodeFundTransferFundOptParams,
  encodeFundTransferSubmitOptParams,
} from "../core/hookEncoding.js";
import { BaseAcpClient } from "./baseAcpClient.js";
import type {
  ApproveAllowanceParams,
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
  SolanaInstructionLike,
} from "../providers/types.js";
import {
  JOB_CREATED_EVENT_DISC,
  ACP_COMMITMENT,
  EVM_NO_EVALUATOR_ADDRESS,
  SOLANA_NO_EVALUATOR_ADDRESS,
  INTENT_KIND_FUND_REQUEST,
  INTENT_KIND_ESCROW,
  SOLANA_CHAIN_ID_CLUSTERS,
} from "../core/constants.js";

import { buildJobStateRetryGuard } from "../core/solana/jobStateRetryGuard.js";
import {
  decorateSendError,
  extractInstructionCustomCode,
} from "../core/solana/programErrors.js";
import { SolanaTransactionError } from "../providers/solana/txConfirmation.js";

// Codama-generated imports (direct file paths for Node v24 ESM compatibility)
import { fetchAcpState } from "../core/solana/generated/acp/accounts/acpState.js";
import { fetchJob } from "../core/solana/generated/acp/accounts/job.js";
import { getCreateJobInstructionAsync } from "../core/solana/generated/acp/instructions/createJob.js";
import { getSetBudgetInstruction } from "../core/solana/generated/acp/instructions/setBudget.js";
import { getFundInstruction } from "../core/solana/generated/acp/instructions/fund.js";
import { getSubmitInstructionAsync } from "../core/solana/generated/acp/instructions/submit.js";
import { getCompleteInstructionAsync } from "../core/solana/generated/acp/instructions/complete.js";
import { getRejectInstructionAsync } from "../core/solana/generated/acp/instructions/reject.js";
import { getJobCreatedDecoder } from "../core/solana/generated/acp/types/jobCreated.js";
import { fetchMaybeFundRequestIntentId } from "../core/solana/generated/fund-transfer-hook/accounts/fundRequestIntentId.js";
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

const DEFAULT_PUBKEY = SOLANA_NO_EVALUATOR_ADDRESS as Address;

/**
 * Encode a completion/rejection reason into the on-chain [u8; 32] slot, mirroring
 * the EVM client's `toBytes32` (evmAcpClient.ts):
 *   - an already-32-byte hex value passes through unchanged;
 *   - a reason whose UTF-8 fits in 32 bytes is stored as right-zero-padded text,
 *     so short reasons stay human-readable on-chain;
 *   - a longer reason is stored as its keccak256 commitment.
 * Unlike the deliverable (which is always hashed because the full text is kept
 * off-chain via postDeliverable), the reason has no off-chain copy, so short
 * reasons must remain readable rather than being hashed and lost.
 */
function encodeReasonBytes(reason: string): Uint8Array {
  if (reason.startsWith("0x") && reason.length === 66) {
    return hexToBytes(reason as Hex);
  }
  const utf8 = new TextEncoder().encode(reason);
  if (utf8.length <= 32) {
    return fixEncoderSize(getBytesEncoder(), 32).encode(utf8) as Uint8Array;
  }
  return hexToBytes(keccak256(toHex(reason)));
}

export class SolanaAcpClient extends BaseAcpClient<SolanaInstructionLike[]> {
  private readonly provider: ISolanaProviderAdapter;
  // Job PDAs are per-cluster: the same job id exists independently on devnet
  // and mainnet, so cache entries are keyed `${chainId}:${jobId}`.
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
    instructions: SolanaInstructionLike[]
  ): Promise<string | string[]> {
    // Lets sponsored adapters distinguish a WrongStatus caused by sponsor-node
    // simulation lag (retry) from a genuine one, e.g. an already-completed job
    // (fail fast). Non-sponsored adapters ignore it.
    const { guard, lastDiagnosis } = buildJobStateRetryGuard(
      this.provider.getRpc(chainId),
      this.programAddress(chainId),
      instructions
    );
    try {
      return await this.provider.sendInstructions(chainId, instructions, {
        retryGuard: guard,
      });
    } catch (err) {
      throw decorateSendError(err, lastDiagnosis());
    }
  }

  /**
   * Detects the hook's InvalidJob (error 6000) on a confirmed on-chain
   * failure — the error older hook deployments throw when a prepared intent
   * PDA goes stale before inclusion. Rebuilding from fresh state and
   * resending is always safe: the failed transaction is atomic, so nothing
   * was applied.
   *
   * Code 6000 collides across programs (ACP core Unauthorized, router
   * OnlyACPContract), so the verdict is confirmed against the transaction's
   * own logs; an unreachable log fetch counts as inconclusive and retries.
   */
  override async isStalePrepareError(
    chainId: number,
    err: unknown
  ): Promise<boolean> {
    if (!(err instanceof SolanaTransactionError) || err.phase !== "failed") {
      return false;
    }
    if (extractInstructionCustomCode(err.txErr) !== HOOK_INVALID_JOB_CODE) {
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
      return logs.some((log) => log.includes("Error Code: InvalidJob"));
    } catch {
      return true;
    }
  }

  override async submitPrepared(
    chainId: number,
    prepared: PreparedTxInput
  ): Promise<string | string[]> {
    const instructions: SolanaInstructionLike[] = [];

    for (const item of prepared) {
      if (item.chain !== "solana") {
        throw new Error(
          `Prepared transaction chain mismatch: expected "solana" but received "${item.chain}".`
        );
      }
      instructions.push(...item.tx);
    }

    return this.execute(chainId, instructions);
  }

  override async createJob(
    chainId: number,
    params: CreateJobParams
  ): Promise<PreparedSolanaTx> {
    const rpc = this.provider.getRpc(chainId);
    const signer = this.provider.getSigner();

    const acpStatePda = await this.deriveAcpStatePda(chainId);
    const acpState = await fetchAcpState(rpc, acpStatePda, { commitment: ACP_COMMITMENT });
    // On-chain job_counter stores the LAST issued ID (EVM jobCounter
    // parity); the job we are about to create receives counter+1.
    const jobCounter = acpState.data.jobCounter + 1n;

    const jobPda = await this.deriveJobPda(chainId, signer.address, jobCounter);

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
    if (params.hookAddress) {
      const hookStatePda = await this.deriveHookStatePda(
        params.hookAddress as Address
      );
      extraAccounts.push({ address: hookStatePda, role: AccountRole.READONLY });
    }

    this.jobPdaCache.set(`${chainId}:${jobCounter}`, jobPda);

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

    let mintAddress: Address;
    if (job.data.budgetMint.__option === "Some") {
      mintAddress = job.data.budgetMint.value;
    } else {
      const acpStatePda = await this.deriveAcpStatePda(chainId);
      const acpState = await fetchAcpState(rpc, acpStatePda, { commitment: ACP_COMMITMENT });
      mintAddress = acpState.data.paymentToken;
    }

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    // F-80: the hook decodes the fund-request proposal from opt_params
    // ([token 32][amount u64 LE 8][destination 32]). EVM parity: omitted
    // optParams proposes nothing, exactly like "0x" — callers encode a fund
    // request via encodeFundTransferSetBudgetOptParams (F-82: the amount may
    // exceed the budget; token = default pubkey cancels a live proposal).
    const setBudgetOptParams: Uint8Array =
      params.optParams !== undefined
        ? hexToBytes(params.optParams)
        : EMPTY_OPT_PARAMS;

    const ix = getSetBudgetInstruction(
      {
        caller: signer,
        job: jobPda,
        budgetMint: mintAddress,
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
      // job account is appended because the core's M-01 guard requires more
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
        job.data.jobId,
        INTENT_KIND_FUND_REQUEST
      );
      const fundRequestIntentIdPda = await this.deriveFundRequestIntentIdPda(
        hookAddress,
        job.data.jobId
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

    let mintAddress: Address;
    if (job.data.budgetMint.__option === "Some") {
      mintAddress = job.data.budgetMint.value;
    } else {
      const acpStatePda = await this.deriveAcpStatePda(chainId);
      const acpState = await fetchAcpState(rpc, acpStatePda, { commitment: ACP_COMMITMENT });
      mintAddress = acpState.data.paymentToken;
    }

    const vaultAta = await this.deriveAta(vaultAuthorityPda, mintAddress);
    const clientAta = await this.deriveAta(signer.address, mintAddress);

    const createClientAtaIx = this.buildCreateAtaIdempotentIx(
      signer.address,
      clientAta,
      signer.address,
      mintAddress
    );

    const createVaultAtaIx = this.buildCreateAtaIdempotentIx(
      signer.address,
      vaultAta,
      vaultAuthorityPda,
      mintAddress
    );

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    const hookPreIxs: SolanaInstructionLike[] = [];
    const hookPostIxs: SolanaInstructionLike[] = [];
    // F-82: when the client's outer Approve bracket must survive into
    // post_fund (budget-mint intent above budget), the optional hook_delegate
    // account is omitted from the core fund instruction — the core's F-25
    // approve/revoke both run only when hook_delegate is passed, and would
    // otherwise overwrite the bracket approval (single SPL delegate slot).
    let passHookDelegate = true;
    // The fund confirmation opt_params MUST match the on-chain fund-request
    // intent (token, amount, recipient) that post_set_budget created — the
    // hook validates them in post_fund via validate_intent_confirmation.
    // F-80: the intent carries whatever the provider proposed in setBudget
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
        await this.deriveFundRequestIntentIdPda(hookAddress, job.data.jobId);
      // F-80: a hooked job may have no fund-request at all (nothing proposed,
      // or proposal cancelled — intent_id 0 sentinel). post_fund no-ops on
      // the sysvar-only skip set in that case.
      const maybeFriid = await fetchMaybeFundRequestIntentId(
        rpc,
        fundRequestIntentIdPda,
        { commitment: ACP_COMMITMENT }
      );
      if (!maybeFriid.exists || maybeFriid.data.intentId === 0n) {
        fundOptParams = EMPTY_OPT_PARAMS;
        extraAccounts.push(
          { address: hookStatePda, role: AccountRole.WRITABLE },
          { address: SYSVAR_INSTRUCTIONS_ID, role: AccountRole.READONLY }
        );
      } else {
      const intentPda = await this.deriveIntentPda(
        hookAddress,
        job.data.jobId,
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

      // F-80/F-82: the core's F-25 delegate approval only covers the client's
      // budget-mint token account, bounded to budget_amount, funded jobs
      // only. Whenever that approval cannot cover the pull — foreign mint,
      // zero-budget job, or a budget-mint intent ABOVE the budget (F-82) —
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
        job: jobPda,
        clientTokenAccount: clientAta,
        vault: vaultAta,
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
      createVaultAtaIx,
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

    // Store a 32-byte keccak256 commitment of the deliverable on-chain, matching
    // the EVM client (`keccak256(toHex(deliverable))` -> bytes32) and the backend,
    // which reads this field as `deliverableHash`. The full deliverable text is
    // persisted off-chain via `postDeliverable`. UTF-8 truncation into 32 bytes
    // (the previous behaviour) silently dropped anything past 32 bytes.
    const deliverableBytes = hexToBytes(keccak256(toHex(params.deliverable)));

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    const isFunded = job.data.budgetAmount > 0n;

    let vaultAccounts: Record<string, Address> = {};
    let hookNamedAccounts: Record<string, Address> = {};
    const preIxs: SolanaInstructionLike[] = [];
    const postIxs: SolanaInstructionLike[] = [];
    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    let completeOptParams: Uint8Array = EMPTY_OPT_PARAMS;
    let submitOptParams: Uint8Array = params.optParams
      ? hexToBytes(params.optParams)
      : EMPTY_OPT_PARAMS;

    if (isFunded) {
      const vaultAuthorityPda = await this.deriveVaultAuthorityPda(chainId, jobPda);
      const acpStatePda = await this.deriveAcpStatePda(chainId);
      const acpState = await fetchAcpState(rpc, acpStatePda, { commitment: ACP_COMMITMENT });

      let mintAddress: Address;
      if (job.data.budgetMint.__option === "Some") {
        mintAddress = job.data.budgetMint.value;
      } else {
        mintAddress = acpState.data.paymentToken;
      }

      const vaultAta = await this.deriveAta(vaultAuthorityPda, mintAddress);
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
        vault: vaultAta,
        vaultAuthority: vaultAuthorityPda,
        providerTokenAccount: providerAta,
        treasuryTokenAccount: treasuryAta,
        platformTreasury: acpState.data.platformTreasury,
      };

      if (hookAddress) {
        const SYSVAR_INSTRUCTIONS_ID =
          "Sysvar1nstructions1111111111111111111111111" as Address;
        const SYSTEM_PROGRAM_ID =
          "11111111111111111111111111111111" as Address;
        const TOKEN_PROGRAM_ID =
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

        // F-80: the hook decodes the escrow proposal from submit opt_params
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
          job.data.jobId,
          INTENT_KIND_ESCROW
        );
        const provEscrowIntentIdPda =
          await this.deriveProviderEscrowIntentIdPda(
            hookAddress,
            job.data.jobId
          );
        const escrowAuthorityPda = await this.deriveEscrowAuthorityPda(
          hookAddress,
          job.data.jobId
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

        // Delegate coverage (F-25/F-80): the core approves the hook delegate
        // on providerHookTokenAccount (budget mint, bounded to budget_amount)
        // ONLY in the evaluator branch of submit. Whenever that approval does
        // not cover the escrow pull — no-evaluator auto-complete (on-chain
        // gap), or a foreign-mint stake — bracket the submit instruction in
        // an outer Approve/Revoke on the actual source account.
        const coreApprovalCovers = hasEvaluator && escrowToken === mintAddress;
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

        if (hasEvaluator) {
          extraAccounts.push(...submitSlice);
        } else {
          // No evaluator: submit auto-completes in the same instruction, which
          // fires the after-Submit AND after-Complete hooks. after-Complete
          // routes to auto_sign_escrow, whose account layout differs from
          // post_submit's. Use F-66 per-action mode: a non-empty
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
          // evaluator-or-escrow invariant on-chain; the hook CPI still needs
          // its state account and the caller-validation sysvar (the program
          // appends the job account the hook reads last). The job account is
          // additionally passed because the core's M-01 guard (submit.rs)
          // requires more than [hookState, sysvar] whenever budget > 0 on a
          // hooked job — without it the core rejects the tx with
          // MissingRequiredAccount before the hook's semantic check runs.
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

    const reasonBytes = encodeReasonBytes(params.reason);

    const vaultAuthorityPda = await this.deriveVaultAuthorityPda(chainId, jobPda);

    const acpStatePda = await this.deriveAcpStatePda(chainId);
    const acpState = await fetchAcpState(rpc, acpStatePda, { commitment: ACP_COMMITMENT });

    let mintAddress: Address;
    if (job.data.budgetMint.__option === "Some") {
      mintAddress = job.data.budgetMint.value;
    } else {
      mintAddress = acpState.data.paymentToken;
    }

    const vaultAta = await this.deriveAta(vaultAuthorityPda, mintAddress);
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
      extraAccounts.push(
        { address: hookStatePda, role: AccountRole.WRITABLE },
        { address: SYSVAR_INSTRUCTIONS_ID, role: AccountRole.READONLY }
      );

      const provEscrowIntentIdPda =
        await this.deriveProviderEscrowIntentIdPda(
          hookAddress,
          job.data.jobId
        );
      const maybePeii = await fetchMaybeProviderEscrowIntentId(
        rpc,
        provEscrowIntentIdPda,
        { commitment: ACP_COMMITMENT }
      );

      if (maybePeii.exists) {
        const escrowIntentPda = await this.deriveIntentPda(
          hookAddress,
          job.data.jobId,
          INTENT_KIND_ESCROW
        );
        const intent = await fetchIntent(rpc, escrowIntentPda, {
          commitment: ACP_COMMITMENT,
        });
        const escrowAuthorityPda = await this.deriveEscrowAuthorityPda(
          hookAddress,
          job.data.jobId
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
          { address: provEscrowIntentIdPda, role: AccountRole.READONLY },
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
        vault: vaultAta,
        vaultAuthority: vaultAuthorityPda,
        providerTokenAccount: providerAta,
        treasuryTokenAccount: treasuryAta,
        ...(evaluatorAta ? { evaluatorTokenAccount: evaluatorAta } : {}),
        platformTreasury: acpState.data.platformTreasury,
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

      let mintAddress: Address;
      if (job.data.budgetMint.__option === "Some") {
        mintAddress = job.data.budgetMint.value;
      } else {
        mintAddress = acpState.data.paymentToken;
      }
      vault = await this.deriveAta(vaultAuthority, mintAddress);
      clientTokenAccount = await this.deriveAta(job.data.client, mintAddress);
    }

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    if (hookAddress) {
      const SYSVAR_INSTRUCTIONS_ID =
        "Sysvar1nstructions1111111111111111111111111" as Address;
      const TOKEN_PROGRAM_ID =
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

      const hookStatePda = await this.deriveHookStatePda(hookAddress);
      extraAccounts.push(
        { address: hookStatePda, role: AccountRole.WRITABLE },
        { address: SYSVAR_INSTRUCTIONS_ID, role: AccountRole.READONLY }
      );

      const provEscrowIntentIdPda =
        await this.deriveProviderEscrowIntentIdPda(
          hookAddress,
          job.data.jobId
        );
      const maybePeii = await fetchMaybeProviderEscrowIntentId(
        rpc,
        provEscrowIntentIdPda,
        { commitment: ACP_COMMITMENT }
      );

      if (maybePeii.exists) {
        const escrowIntentPda = await this.deriveIntentPda(
          hookAddress,
          job.data.jobId,
          INTENT_KIND_ESCROW
        );
        const intent = await fetchIntent(rpc, escrowIntentPda, {
          commitment: ACP_COMMITMENT,
        });
        const escrowAuthorityPda = await this.deriveEscrowAuthorityPda(
          hookAddress,
          job.data.jobId
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
          { address: provEscrowIntentIdPda, role: AccountRole.READONLY },
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
        platformTreasury: acpState.data.platformTreasury,
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

  override async getJobIdFromTxHash(
    chainId: number,
    txHash: string
  ): Promise<bigint | null> {
    const rpc = this.provider.getRpc(chainId);

    const tx = await rpc
      .getTransaction(txHash as Signature, {
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send();

    if (!tx) return null;

    const logs = tx.meta?.logMessages ?? [];
    const decoder = getJobCreatedDecoder();

    for (const log of logs) {
      if (!log.startsWith("Program data: ")) continue;
      const data = Uint8Array.from(
        atob(log.slice("Program data: ".length)),
        (c) => c.charCodeAt(0)
      );

      if (data.length < 8) continue;
      if (!JOB_CREATED_EVENT_DISC.every((b, i) => data[i] === b)) continue;

      return decoder.decode(data.slice(8)).jobId;
    }

    return null;
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

      return {
        id: job.jobId,
        client: job.client,
        provider: job.provider,
        evaluator: job.evaluator,
        description: job.description,
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

  // --- Private helpers ---

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
    jobCounter: bigint
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.programAddress(chainId),
      seeds: [
        getUtf8Encoder().encode("job"),
        getAddressEncoder().encode(client),
        getU64Encoder().encode(jobCounter),
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
   * Intent PDAs are job-scoped — ["intent", job_id, kind] with kind
   * 0 = fund-request, 1 = escrow. Derived from the job id alone, so prepare
   * never predicts the hook's global intent counter (predicting it raced
   * whenever two intent-creating transactions were in flight).
   */
  private async deriveIntentPda(
    hookProgram: Address,
    jobId: bigint,
    kind: typeof INTENT_KIND_FUND_REQUEST | typeof INTENT_KIND_ESCROW
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: hookProgram,
      seeds: [
        getUtf8Encoder().encode("intent"),
        getU64Encoder().encode(jobId),
        new Uint8Array([kind]),
      ],
    });
    return pda;
  }

  private async deriveFundRequestIntentIdPda(
    hookProgram: Address,
    jobId: bigint
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: hookProgram,
      seeds: [
        getUtf8Encoder().encode("fund_request_intent_id"),
        getU64Encoder().encode(jobId),
      ],
    });
    return pda;
  }

  private async deriveProviderEscrowIntentIdPda(
    hookProgram: Address,
    jobId: bigint
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: hookProgram,
      seeds: [
        getUtf8Encoder().encode("provider_escrow_intent_id"),
        getU64Encoder().encode(jobId),
      ],
    });
    return pda;
  }

  private async deriveEscrowAuthorityPda(
    hookProgram: Address,
    jobId: bigint
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: hookProgram,
      seeds: [
        getUtf8Encoder().encode("escrow_authority"),
        getU64Encoder().encode(jobId),
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

  private async resolveJobPda(
    chainId: number,
    jobId: bigint,
    clientAddress?: string
  ): Promise<Address> {
    const cacheKey = `${chainId}:${jobId}`;
    const cached = this.jobPdaCache.get(cacheKey);
    if (cached) return cached;

    const client = (clientAddress ??
      this.provider.getSigner().address) as Address;
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
