import {
  type Address,
  type Signature,
  AccountRole,
  getProgramDerivedAddress,
  getAddressEncoder,
  getU64Encoder,
  fixEncoderSize,
  getUtf8Encoder,
} from "@solana/kit";
import { hexToBytes } from "viem";
import { BaseAcpClient } from "./baseAcpClient";
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
} from "../core/operations";
import type {
  ISolanaProviderAdapter,
  SolanaInstructionLike,
} from "../providers/types";
import { JOB_CREATED_EVENT_DISC } from "../core/solana/constants";

// Codama-generated imports (direct file paths for Node v24 ESM compatibility)
import { fetchAcpState } from "../core/solana/generated/acp/accounts/acpState";
import { fetchJob } from "../core/solana/generated/acp/accounts/job";
import { getCreateJobInstructionAsync } from "../core/solana/generated/acp/instructions/createJob";
import { getSetBudgetInstruction } from "../core/solana/generated/acp/instructions/setBudget";
import { getFundInstruction } from "../core/solana/generated/acp/instructions/fund";
import { getSubmitInstructionAsync } from "../core/solana/generated/acp/instructions/submit";
import { getCompleteInstructionAsync } from "../core/solana/generated/acp/instructions/complete";
import { getRejectInstructionAsync } from "../core/solana/generated/acp/instructions/reject";
import { getJobCreatedDecoder } from "../core/solana/generated/acp/types/jobCreated";

// JobState enum values (inlined to avoid Node v24 ESM enum transform issues)
const JOB_STATE_FUNDED = 1;
const JOB_STATE_SUBMITTED = 2;

const EMPTY_OPT_PARAMS = new Uint8Array(0);

export class SolanaAcpClient extends BaseAcpClient<SolanaInstructionLike[]> {
  private readonly provider: ISolanaProviderAdapter;
  private readonly contractAddress: string;
  private jobPdaCache: Map<bigint, Address> = new Map();

  private constructor(
    contractAddresses: Record<number, string>,
    provider: ISolanaProviderAdapter,
  ) {
    super(contractAddresses);
    this.provider = provider;
    // Use the first (and typically only) contract address
    const addresses = Object.values(contractAddresses);
    if (addresses.length === 0) {
      throw new Error("At least one contract address must be provided.");
    }
    this.contractAddress = addresses[0]!;
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
    instructions: SolanaInstructionLike[],
  ): Promise<string | string[]> {
    return this.provider.sendInstructions(instructions);
  }

  override async submitPrepared(
    _chainId: number,
    prepared: PreparedTxInput,
  ): Promise<string | string[]> {
    const instructions: SolanaInstructionLike[] = [];

    for (const item of prepared) {
      if (item.chain !== "solana") {
        throw new Error(
          `Prepared transaction chain mismatch: expected "solana" but received "${item.chain}".`,
        );
      }
      instructions.push(...item.tx);
    }

    return this.execute(instructions);
  }

  override async createJob(
    _chainId: number,
    params: CreateJobParams,
  ): Promise<PreparedSolanaTx> {
    const rpc = this.provider.getRpc();
    const signer = this.provider.getSigner();

    const acpStatePda = await this.deriveAcpStatePda();
    const acpState = await fetchAcpState(rpc, acpStatePda);
    const jobCounter = acpState.data.jobCounter;

    const jobPda = await this.deriveJobPda(signer.address, jobCounter);

    let hookWhitelist: Address | undefined;
    let hookProgram: Address | undefined;
    if (params.hookAddress) {
      hookProgram = params.hookAddress as Address;
      hookWhitelist = await this.deriveHookWhitelistPda(hookProgram);
    }

    const ix = await getCreateJobInstructionAsync({
      client: signer,
      job: jobPda,
      provider: params.providerAddress as Address,
      evaluator: params.evaluatorAddress as Address,
      description: params.description,
      expiredAt: params.expiredAt,
      hookAddress: params.hookAddress ? (params.hookAddress as Address) : null,
      ...(hookWhitelist ? { hookWhitelist } : {}),
      ...(hookProgram ? { hookProgram } : {}),
    });

    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    if (hookProgram) {
      const hookStatePda = await this.deriveHookStatePda(hookProgram);
      extraAccounts.push({ address: hookStatePda, role: AccountRole.READONLY });
    }

    this.jobPdaCache.set(jobCounter, jobPda);

    return this.wrapMany([
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
  }

  override async setBudget(
    _chainId: number,
    params: SetBudgetParams,
  ): Promise<PreparedSolanaTx> {
    const rpc = this.provider.getRpc();
    const signer = this.provider.getSigner();
    const jobPda = await this.resolveJobPda(params.jobId, params.clientAddress);
    const job = await fetchJob(rpc, jobPda, { commitment: "confirmed" });

    let mintAddress: Address;
    if (job.data.budgetMint.__option === "Some") {
      mintAddress = job.data.budgetMint.value;
    } else {
      const acpStatePda = await this.deriveAcpStatePda();
      const acpState = await fetchAcpState(rpc, acpStatePda);
      mintAddress = acpState.data.paymentToken;
    }

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    const ix = getSetBudgetInstruction({
      caller: signer,
      job: jobPda,
      budgetMint: mintAddress,
      amount: params.amount,
      ...(hookAddress ? { hookProgram: hookAddress } : {}),
      ...(hookAddress
        ? { hookWhitelist: await this.deriveHookWhitelistPda(hookAddress) }
        : {}),
      optParams: params.optParams
        ? hexToBytes(params.optParams)
        : EMPTY_OPT_PARAMS,
    });

    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    if (hookAddress) {
      const hookStatePda = await this.deriveHookStatePda(hookAddress);
      extraAccounts.push({
        address: hookStatePda,
        role: AccountRole.WRITABLE,
      });
    }

    return this.wrapMany([
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
  }

  override async approveAllowance(
    _chainId: number,
    _params: ApproveAllowanceParams,
  ): Promise<PreparedSolanaTx> {
    throw new Error(
      "approveAllowance is not supported by SolanaAcpClient. Check capability flags first.",
    );
  }

  override async fund(
    _chainId: number,
    params: FundParams,
  ): Promise<PreparedSolanaTx> {
    const rpc = this.provider.getRpc();
    const signer = this.provider.getSigner();
    const jobPda = await this.resolveJobPda(params.jobId, params.clientAddress);
    const job = await fetchJob(rpc, jobPda, { commitment: "confirmed" });

    const vaultAuthorityPda = await this.deriveVaultAuthorityPda(jobPda);

    let mintAddress: Address;
    if (job.data.budgetMint.__option === "Some") {
      mintAddress = job.data.budgetMint.value;
    } else {
      const acpStatePda = await this.deriveAcpStatePda();
      const acpState = await fetchAcpState(rpc, acpStatePda);
      mintAddress = acpState.data.paymentToken;
    }

    const vaultAta = await this.deriveAta(vaultAuthorityPda, mintAddress);
    const clientAta = await this.deriveAta(signer.address, mintAddress);

    const createVaultAtaIx = this.buildCreateAtaIdempotentIx(
      signer.address,
      vaultAta,
      vaultAuthorityPda,
      mintAddress,
    );

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    const ix = getFundInstruction({
      client: signer,
      job: jobPda,
      clientTokenAccount: clientAta,
      vault: vaultAta,
      vaultAuthority: vaultAuthorityPda,
      mint: mintAddress,
      ...(hookAddress ? { hookProgram: hookAddress } : {}),
      ...(hookAddress
        ? { hookWhitelist: await this.deriveHookWhitelistPda(hookAddress) }
        : {}),
      ...(hookAddress
        ? { hookDelegate: await this.deriveHookDelegatePda(hookAddress) }
        : {}),
      expectedBudget: params.expectedBudget,
      optParams: params.optParams
        ? hexToBytes(params.optParams)
        : EMPTY_OPT_PARAMS,
    });

    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    if (hookAddress) {
      const hookStatePda = await this.deriveHookStatePda(hookAddress);
      extraAccounts.push({
        address: hookStatePda,
        role: AccountRole.WRITABLE,
      });
    }

    return this.wrapMany([
      createVaultAtaIx,
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
  }

  override async submit(
    _chainId: number,
    params: SubmitParams,
  ): Promise<PreparedSolanaTx> {
    const rpc = this.provider.getRpc();
    const signer = this.provider.getSigner();
    const jobPda = await this.resolveJobPda(params.jobId, params.clientAddress);
    const job = await fetchJob(rpc, jobPda, { commitment: "confirmed" });

    const deliverableBytes = fixEncoderSize(getUtf8Encoder(), 32).encode(
      params.deliverable,
    );

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    const ix = await getSubmitInstructionAsync({
      provider: signer,
      job: jobPda,
      deliverable: deliverableBytes,
      ...(hookAddress ? { hookProgram: hookAddress } : {}),
      ...(hookAddress
        ? { hookWhitelist: await this.deriveHookWhitelistPda(hookAddress) }
        : {}),
      optParams: params.optParams
        ? hexToBytes(params.optParams)
        : EMPTY_OPT_PARAMS,
    });

    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    if (hookAddress) {
      const hookStatePda = await this.deriveHookStatePda(hookAddress);
      extraAccounts.push({
        address: hookStatePda,
        role: AccountRole.WRITABLE,
      });
    }

    return this.wrapMany([
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
  }

  override async complete(
    _chainId: number,
    params: CompleteParams,
  ): Promise<PreparedSolanaTx> {
    const rpc = this.provider.getRpc();
    const signer = this.provider.getSigner();
    const jobPda = await this.resolveJobPda(params.jobId, params.clientAddress);
    const job = await fetchJob(rpc, jobPda, { commitment: "confirmed" });

    const reasonBytes = fixEncoderSize(getUtf8Encoder(), 32).encode(
      params.reason,
    );

    const vaultAuthorityPda = await this.deriveVaultAuthorityPda(jobPda);

    const acpStatePda = await this.deriveAcpStatePda();
    const acpState = await fetchAcpState(rpc, acpStatePda);

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
      mintAddress,
    );

    let evaluatorAta: Address | undefined;
    if (acpState.data.evaluatorFeeBp > 0n) {
      evaluatorAta = await this.deriveAta(job.data.evaluator, mintAddress);
    }

    const hookAddress =
      job.data.hookAddress.__option === "Some"
        ? job.data.hookAddress.value
        : undefined;

    const extraAccounts: SolanaInstructionLike["accounts"] = [];
    if (hookAddress) {
      const hookStatePda = await this.deriveHookStatePda(hookAddress);
      extraAccounts.push({
        address: hookStatePda,
        role: AccountRole.WRITABLE,
      });
    }

    const ix = await getCompleteInstructionAsync({
      evaluator: signer,
      job: jobPda,
      vault: vaultAta,
      vaultAuthority: vaultAuthorityPda,
      providerTokenAccount: providerAta,
      treasuryTokenAccount: treasuryAta,
      ...(evaluatorAta ? { evaluatorTokenAccount: evaluatorAta } : {}),
      platformTreasury: acpState.data.platformTreasury,
      ...(hookAddress ? { hookProgram: hookAddress } : {}),
      ...(hookAddress
        ? { hookWhitelist: await this.deriveHookWhitelistPda(hookAddress) }
        : {}),
      reason: reasonBytes,
      optParams: params.optParams
        ? hexToBytes(params.optParams)
        : EMPTY_OPT_PARAMS,
    });

    return this.wrapMany([
      {
        programAddress: ix.programAddress,
        accounts: [...ix.accounts, ...extraAccounts],
        data: ix.data as Uint8Array,
      },
    ]);
  }

  override async reject(
    _chainId: number,
    params: RejectParams,
  ): Promise<PreparedSolanaTx> {
    const rpc = this.provider.getRpc();
    const signer = this.provider.getSigner();
    const jobPda = await this.resolveJobPda(params.jobId, params.clientAddress);
    const job = await fetchJob(rpc, jobPda, { commitment: "confirmed" });
    const acpStatePda = await this.deriveAcpStatePda();
    const acpState = await fetchAcpState(rpc, acpStatePda, {
      commitment: "confirmed",
    });

    const reasonBytes = fixEncoderSize(getUtf8Encoder(), 32).encode(
      params.reason,
    );

    const isFunded =
      job.data.state === JOB_STATE_FUNDED ||
      job.data.state === JOB_STATE_SUBMITTED;

    let vault: Address | undefined;
    let vaultAuthority: Address | undefined;
    let clientTokenAccount: Address | undefined;

    if (isFunded && job.data.budgetAmount > 0n) {
      vaultAuthority = await this.deriveVaultAuthorityPda(jobPda);

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

    const ix = await getRejectInstructionAsync({
      caller: signer,
      job: jobPda,
      ...(vault ? { vault } : {}),
      ...(vaultAuthority ? { vaultAuthority } : {}),
      ...(clientTokenAccount ? { clientTokenAccount } : {}),
      platformTreasury: acpState.data.platformTreasury,
      ...(hookAddress ? { hookProgram: hookAddress } : {}),
      ...(hookAddress
        ? { hookWhitelist: await this.deriveHookWhitelistPda(hookAddress) }
        : {}),
      reason: reasonBytes,
      optParams: params.optParams
        ? hexToBytes(params.optParams)
        : EMPTY_OPT_PARAMS,
    });

    return this.wrapMany([
      {
        programAddress: ix.programAddress,
        accounts: ix.accounts,
        data: ix.data as Uint8Array,
      },
    ]);
  }

  override async getJobIdFromTxHash(
    _chainId: number,
    txHash: string,
  ): Promise<bigint | null> {
    const rpc = this.provider.getRpc();

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
        (c) => c.charCodeAt(0),
      );

      if (data.length < 8) continue;
      if (!JOB_CREATED_EVENT_DISC.every((b, i) => data[i] === b)) continue;

      return decoder.decode(data.slice(8)).jobId;
    }

    return null;
  }

  override async getJob(
    _chainId: number,
    jobId: bigint,
    clientAddress?: string,
  ): Promise<OnChainJob | null> {
    const rpc = this.provider.getRpc();
    const jobPda = await this.resolveJobPda(jobId, clientAddress);

    try {
      const jobAccount = await fetchJob(rpc, jobPda, {
        commitment: "confirmed",
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
        hook:
          job.hookAddress.__option === "Some" ? job.hookAddress.value : "",
      };
    } catch (err) {
      console.error(
        `Failed to fetch job ${jobId} at PDA ${jobPda}:`,
        err,
      );
      return null;
    }
  }

  override async getTokenDecimals(
    _chainId: number,
    tokenAddress: string,
  ): Promise<number> {
    const rpc = this.provider.getRpc();
    const accountInfo = await rpc
      .getAccountInfo(tokenAddress as Address, { encoding: "base64" })
      .send();

    if (!accountInfo.value) {
      throw new Error(`Mint account not found: ${tokenAddress}`);
    }

    // SPL Token mint layout: decimals is at offset 44, 1 byte
    const data = Uint8Array.from(
      atob(accountInfo.value.data[0] as string),
      (c) => c.charCodeAt(0),
    );
    return data[44]!;
  }

  override async getTokenSymbol(
    _chainId: number,
    _tokenAddress: string,
  ): Promise<string> {
    throw new Error(
      "getTokenSymbol is not supported on Solana. Use AssetToken.create() with explicit symbol.",
    );
  }

  // --- Private helpers ---

  private wrapMany(instructions: SolanaInstructionLike[]): PreparedSolanaTx {
    return {
      tx: instructions,
      chain: "solana",
      network: "devnet", // Will be overridden when we have network context
    };
  }

  private async deriveAcpStatePda(): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.contractAddress as Address,
      seeds: [getUtf8Encoder().encode("acp_state")],
    });
    return pda;
  }

  private async deriveJobPda(
    client: Address,
    jobCounter: bigint,
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.contractAddress as Address,
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
    hookProgram: Address,
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.contractAddress as Address,
      seeds: [
        getUtf8Encoder().encode("hook_whitelist"),
        getAddressEncoder().encode(hookProgram),
      ],
    });
    return pda;
  }

  private async deriveHookDelegatePda(
    hookProgram: Address,
  ): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: hookProgram,
      seeds: [getUtf8Encoder().encode("hook_state")],
    });
    return pda;
  }

  private async deriveVaultAuthorityPda(jobPda: Address): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.contractAddress as Address,
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
    jobId: bigint,
    clientAddress?: string,
  ): Promise<Address> {
    const cached = this.jobPdaCache.get(jobId);
    if (cached) return cached;

    const client = (clientAddress ??
      this.provider.getSigner().address) as Address;
    const pda = await this.deriveJobPda(client, jobId);
    this.jobPdaCache.set(jobId, pda);
    return pda;
  }

  private buildCreateAtaIdempotentIx(
    payer: Address,
    ata: Address,
    owner: Address,
    mint: Address,
  ): SolanaInstructionLike {
    const TOKEN_PROGRAM_ID =
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
    const ATA_PROGRAM_ID =
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
    const SYSTEM_PROGRAM_ID =
      "11111111111111111111111111111111" as Address;

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
}
