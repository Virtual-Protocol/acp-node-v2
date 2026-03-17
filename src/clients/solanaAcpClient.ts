import { BaseAcpClient } from "./baseAcpClient";
import type { NetworkContext } from "../core/chains";
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
    contractAddress: string,
    provider: ISolanaProviderAdapter,
    networkContext: Extract<NetworkContext, { family: "solana" }>
  ) {
    super(contractAddress, networkContext);
    this.provider = provider;
  }

  static async create(input: {
    contractAddress: string;
    provider: ISolanaProviderAdapter;
  }): Promise<SolanaAcpClient> {
    const context = await input.provider.getNetworkContext();
    if (context.family !== "solana") {
      throw new Error(
        `SolanaAcpClient requires Solana context, received "${context.family}".`
      );
    }

    return new SolanaAcpClient(input.contractAddress, input.provider, context);
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

  override async createJob(params: CreateJobParams): Promise<PreparedSolanaTx> {
    return this.wrap(
      this.makeIx("createJob", {
        providerAddress: params.providerAddress,
        evaluatorAddress: params.evaluatorAddress,
        expiredAt: params.expiredAt,
        description: params.description,
        hookAddress: params.hookAddress,
      })
    );
  }

  override async setBudget(params: SetBudgetParams): Promise<PreparedSolanaTx> {
    return this.wrap(
      this.makeIx("setBudget", {
        jobId: params.jobId,
        amount: params.amount.toString(),
      })
    );
  }

  override async approveAllowance(
    _params: ApproveAllowanceParams
  ): Promise<PreparedSolanaTx> {
    throw new Error(
      "approveAllowance is not supported by SolanaAcpClient. Check capability flags first."
    );
  }

  override async fund(params: FundParams): Promise<PreparedSolanaTx> {
    return this.wrap(
      this.makeIx("fund", {
        jobId: params.jobId,
      })
    );
  }

  override async submit(params: SubmitParams): Promise<PreparedSolanaTx> {
    return this.wrap(
      this.makeIx("submit", {
        jobId: params.jobId,
        deliverable: params.deliverable,
      })
    );
  }

  override async complete(params: CompleteParams): Promise<PreparedSolanaTx> {
    return this.wrap(
      this.makeIx("complete", {
        jobId: params.jobId,
        reason: params.reason,
      })
    );
  }

  override async reject(params: RejectParams): Promise<PreparedSolanaTx> {
    return this.wrap(
      this.makeIx("reject", {
        jobId: params.jobId,
        reason: params.reason,
      })
    );
  }

  override async getJobIdFromTxHash(): Promise<bigint | null> {
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

  override async getTokenDecimals(_tokenAddress: string): Promise<number> {
    throw new Error(
      "getTokenDecimals is only supported on EVM. Use Erc20Token.create with explicit decimals for Solana."
    );
  }

  private makeIx(
    method: string,
    payload: Record<string, unknown>
  ): SolanaInstructionLike {
    return {
      programId: this.contractAddress,
      keys: [],
      data: JSON.stringify({ method, payload }),
    };
  }

  private wrap(instruction: SolanaInstructionLike): PreparedSolanaTx {
    const context = this.getNetworkContext();
    return {
      tx: [instruction],
      chain: "solana",
      network: context.network,
    };
  }
}
