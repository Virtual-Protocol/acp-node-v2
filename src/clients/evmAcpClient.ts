import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  pad,
  toHex,
  zeroAddress,
  type Address,
  type Call,
  type Hex,
} from "viem";

import { BaseAcpClient } from "./baseAcpClient";
import { ACP_ABI } from "../core/acpAbi";
import type {
  ApproveAllowanceParams,
  CapabilityFlags,
  CompleteParams,
  CreateJobParams,
  FundParams,
  OnChainJob,
  PreparedEvmTx,
  PreparedTxInput,
  RejectParams,
  SetBudgetParams,
  SubmitParams,
} from "../core/operations";
import type { IEvmProviderAdapter } from "../providers/types";
import { parseJobIdFromReceipt, type JobCreatedFilter } from "../utils/events";

export class EvmAcpClient extends BaseAcpClient<Call[]> {
  private readonly provider: IEvmProviderAdapter;

  private constructor(
    contractAddresses: Record<number, string>,
    provider: IEvmProviderAdapter
  ) {
    super(contractAddresses);
    this.provider = provider;
  }

  static async create(input: {
    contractAddresses: Record<number, string>;
    provider: IEvmProviderAdapter;
  }): Promise<EvmAcpClient> {
    return new EvmAcpClient(input.contractAddresses, input.provider);
  }

  override async getAddress(): Promise<Address> {
    return this.provider.getAddress();
  }

  getProvider(): IEvmProviderAdapter {
    return this.provider;
  }

  override getCapabilities(): CapabilityFlags {
    return {
      supportsBatch: true,
      supportsAllowance: true,
    };
  }

  async execute(chainId: number, calls: Call[]): Promise<Address | Address[]> {
    return this.provider.sendCalls(chainId, calls);
  }

  override async submitPrepared(
    chainId: number,
    prepared: PreparedTxInput
  ): Promise<string | string[]> {
    const evmCalls: Call[] = [];

    for (const item of prepared) {
      if (item.chain !== "evm") {
        throw new Error(
          `Prepared transaction chain mismatch: expected "evm" but received "${item.chain}".`
        );
      }
      evmCalls.push(...item.tx);
    }

    return this.execute(chainId, evmCalls);
  }

  override async createJob(
    chainId: number,
    params: CreateJobParams
  ): Promise<PreparedEvmTx> {
    const call = this.buildContractCall(chainId, "createJob", [
      params.providerAddress as Address,
      params.evaluatorAddress as Address,
      BigInt(params.expiredAt),
      params.description,
      (params.hookAddress ?? zeroAddress) as Address,
    ]);
    return this.wrap(chainId, call);
  }

  override async setBudget(
    chainId: number,
    params: SetBudgetParams
  ): Promise<PreparedEvmTx> {
    return this.wrap(
      chainId,
      this.buildContractCall(chainId, "setBudget", [
        BigInt(params.jobId),
        params.amount,
        params.optParams ?? "0x",
      ])
    );
  }

  override async approveAllowance(
    chainId: number,
    params: ApproveAllowanceParams
  ): Promise<PreparedEvmTx> {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [params.spenderAddress as Address, params.amount],
    });

    return this.wrap(chainId, {
      to: params.tokenAddress as Address,
      data,
      value: 0n,
    });
  }

  override async fund(
    chainId: number,
    params: FundParams
  ): Promise<PreparedEvmTx> {
    return this.wrap(
      chainId,
      this.buildContractCall(chainId, "fund", [
        BigInt(params.jobId),
        params.expectedBudget,
        params.optParams ?? "0x",
      ])
    );
  }

  override async submit(
    chainId: number,
    params: SubmitParams
  ): Promise<PreparedEvmTx> {
    return this.wrap(
      chainId,
      this.buildContractCall(chainId, "submit", [
        BigInt(params.jobId),
        EvmAcpClient.toBytes32(params.deliverable),
        params.optParams ?? "0x",
      ])
    );
  }

  override async complete(
    chainId: number,
    params: CompleteParams
  ): Promise<PreparedEvmTx> {
    return this.wrap(
      chainId,
      this.buildContractCall(chainId, "complete", [
        BigInt(params.jobId),
        EvmAcpClient.toBytes32(params.reason),
        params.optParams ?? "0x",
      ])
    );
  }

  override async reject(
    chainId: number,
    params: RejectParams
  ): Promise<PreparedEvmTx> {
    return this.wrap(
      chainId,
      this.buildContractCall(chainId, "reject", [
        BigInt(params.jobId),
        EvmAcpClient.toBytes32(params.reason),
        params.optParams ?? "0x",
      ])
    );
  }

  override async getJobIdFromTxHash(
    chainId: number,
    txHash: string,
    filter?: JobCreatedFilter
  ): Promise<bigint | null> {
    const receipt = await this.provider.getTransactionReceipt(
      chainId,
      txHash as Address
    );
    return parseJobIdFromReceipt(
      receipt,
      this.getContractAddress(chainId) as Address,
      filter
    );
  }

  override async getJob(
    chainId: number,
    jobId: bigint
  ): Promise<OnChainJob | null> {
    const result = await this.provider.readContract(chainId, {
      address: this.getContractAddress(chainId) as Address,
      abi: ACP_ABI as readonly unknown[],
      functionName: "getJob",
      args: [jobId],
    });

    const raw = result as {
      client: string;
      provider: string;
      evaluator: string;
      description: string;
      budget: bigint;
      expiredAt: bigint;
      status: number;
      hook: string;
    };
    return {
      id: jobId,
      client: raw.client,
      provider: raw.provider,
      evaluator: raw.evaluator,
      description: raw.description,
      budget: raw.budget,
      expiredAt: raw.expiredAt,
      status: raw.status,
      hook: raw.hook,
    };
  }

  override async getTokenDecimals(
    chainId: number,
    tokenAddress: string
  ): Promise<number> {
    const result = await this.provider.readContract(chainId, {
      address: tokenAddress as Address,
      abi: erc20Abi,
      functionName: "decimals",
    });
    return Number(result);
  }

  override async getTokenSymbol(
    chainId: number,
    tokenAddress: string
  ): Promise<string> {
    const result = await this.provider.readContract(chainId, {
      address: tokenAddress as Address,
      abi: erc20Abi,
      functionName: "symbol",
    });
    return result as string;
  }

  private static toBytes32(value: string): Hex {
    if (value.startsWith("0x") && value.length === 66) return value as Hex;
    const hex = toHex(value);
    if (hex.length <= 66) return pad(hex, { size: 32, dir: "right" });
    return keccak256(hex);
  }

  private buildContractCall(
    chainId: number,
    functionName:
      | "createJob"
      | "setBudget"
      | "fund"
      | "submit"
      | "complete"
      | "reject",
    args: readonly unknown[]
  ): Call {
    const data = encodeFunctionData({
      abi: ACP_ABI as any,
      functionName,
      args: args as any,
    });

    return {
      to: this.getContractAddress(chainId) as Address,
      data,
      value: 0n,
    };
  }

  private async wrap(chainId: number, call: Call): Promise<PreparedEvmTx> {
    const context = await this.provider.getNetworkContext(chainId);
    return {
      tx: [call],
      chain: "evm",
      network: context.network,
    };
  }
}
