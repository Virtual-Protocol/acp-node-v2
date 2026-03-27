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


export class SolanaAcpClient extends BaseAcpClient<SolanaInstructionLike[]> {
  private readonly provider: ISolanaProviderAdapter;

  private constructor(
    contractAddresses: Record<number, string>,
    provider: ISolanaProviderAdapter
  ) {
    super(contractAddresses);
    this.provider = provider;
  }

  static async create(input: {
    contractAddresses: Record<number, string>;
    provider: ISolanaProviderAdapter;
  }): Promise<SolanaAcpClient> {
    return new SolanaAcpClient(input.contractAddresses, input.provider);
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
    instructions: SolanaInstructionLike[]
  ): Promise<string | string[]> {
    return this.provider.sendInstructions(instructions);
  }

  override async submitPrepared(
    _chainId: number,
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

    return this.execute(instructions);
  }

  override async createJob(
    chainId: number,
    params: CreateJobParams
  ): Promise<PreparedSolanaTx> {
    return this.wrap(
      chainId,
      this.makeIx(chainId, "createJob", {
        providerAddress: params.providerAddress,
        evaluatorAddress: params.evaluatorAddress,
        expiredAt: params.expiredAt,
        description: params.description,
        hookAddress: params.hookAddress,
      })
    );
  }

  override async setBudget(
    chainId: number,
    params: SetBudgetParams
  ): Promise<PreparedSolanaTx> {
    return this.wrap(
      chainId,
      this.makeIx(chainId, "setBudget", {
        jobId: params.jobId,
        amount: params.amount.toString(),
      })
    );
  }

  override async approveAllowance(
    _chainId: number,
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
    return this.wrap(
      chainId,
      this.makeIx(chainId, "fund", {
        jobId: params.jobId,
      })
    );
  }

  override async submit(
    chainId: number,
    params: SubmitParams
  ): Promise<PreparedSolanaTx> {
    return this.wrap(
      chainId,
      this.makeIx(chainId, "submit", {
        jobId: params.jobId,
        deliverable: params.deliverable,
      })
    );
  }

  override async complete(
    chainId: number,
    params: CompleteParams
  ): Promise<PreparedSolanaTx> {
    return this.wrap(
      chainId,
      this.makeIx(chainId, "complete", {
        jobId: params.jobId,
        reason: params.reason,
      })
    );
  }

  override async reject(
    chainId: number,
    params: RejectParams
  ): Promise<PreparedSolanaTx> {
    return this.wrap(
      chainId,
      this.makeIx(chainId, "reject", {
        jobId: params.jobId,
        reason: params.reason,
      })
    );
  }

  override async getJobIdFromTxHash(_chainId: number): Promise<bigint | null> {
    throw new Error(
      "getJobIdFromTxHash is not implemented for SolanaAcpClient."
    );
  }

  override async getJob(
    _chainId: number,
    _jobId: bigint
  ): Promise<OnChainJob | null> {
    throw new Error("getJob is not implemented for SolanaAcpClient.");
  }

  override async getTokenDecimals(
    _chainId: number,
    _tokenAddress: string
  ): Promise<number> {
    throw new Error(
      "getTokenDecimals is only supported on EVM. Use Erc20Token.create with explicit decimals for Solana."
    );
  }

  private makeIx(
    chainId: number,
    method: string,
    payload: Record<string, unknown>
  ): SolanaInstructionLike {
    return {
      programId: this.getContractAddress(chainId),
      keys: [],
      data: JSON.stringify({ method, payload }),
    };
  }

  private async wrap(
    chainId: number,
    instruction: SolanaInstructionLike
  ): Promise<PreparedSolanaTx> {
    const context = await this.provider.getNetworkContext(chainId);
    return {
      tx: [instruction],
      chain: "solana",
      network: context.network,
    };
  }
}
