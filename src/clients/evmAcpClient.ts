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
import type { NetworkContext } from "../core/chains";
import type {
  ApproveAllowanceParams,
  CapabilityFlags,
  CompleteParams,
  CreateJobParams,
  FundParams,
  OnChainJob,
  OperationResult,
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
    contractAddress: Address,
    provider: IEvmProviderAdapter,
    networkContext: Extract<NetworkContext, { family: "evm" }>
  ) {
    super(contractAddress, networkContext);
    this.provider = provider;
  }

  static async create(input: {
    contractAddress: Address;
    provider: IEvmProviderAdapter;
  }): Promise<EvmAcpClient> {
    const context = await input.provider.getNetworkContext();
    if (context.family !== "evm") {
      throw new Error(
        `EvmAcpClient requires EVM context, received "${context.family}".`
      );
    }

    return new EvmAcpClient(input.contractAddress, input.provider, context);
  }

  override async getAddress(): Promise<string> {
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

  async execute(calls: Call[]): Promise<Address | Address[]> {
    return this.provider.sendCalls(calls);
  }

  override async submitPrepared(
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

    return this.execute(evmCalls);
  }

  override async createJob(params: CreateJobParams): Promise<PreparedEvmTx> {
    const call = this.buildContractCall("createJob", [
      params.providerAddress as Address,
      params.evaluatorAddress as Address,
      BigInt(params.expiredAt),
      params.description,
      (params.hookAddress ?? zeroAddress) as Address,
    ]);
    return this.wrap(call);
  }

  override async setBudget(params: SetBudgetParams): Promise<PreparedEvmTx> {
    return this.wrap(
      this.buildContractCall("setBudget", [
        BigInt(params.jobId),
        params.amount,
        params.optParams ?? "0x",
      ])
    );
  }

  override async approveAllowance(
    params: ApproveAllowanceParams
  ): Promise<PreparedEvmTx> {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [params.spenderAddress as Address, params.amount],
    });

    return this.wrap({
      to: params.tokenAddress as Address,
      data,
      value: 0n,
    });
  }

  override async fund(params: FundParams): Promise<PreparedEvmTx> {
    return this.wrap(
      this.buildContractCall("fund", [
        BigInt(params.jobId),
        params.optParams ?? "0x",
      ])
    );
  }

  override async submit(params: SubmitParams): Promise<PreparedEvmTx> {
    return this.wrap(
      this.buildContractCall("submit", [
        BigInt(params.jobId),
        EvmAcpClient.toBytes32(params.deliverable),
        params.optParams ?? "0x",
      ])
    );
  }

  override async complete(params: CompleteParams): Promise<PreparedEvmTx> {
    return this.wrap(
      this.buildContractCall("complete", [
        BigInt(params.jobId),
        EvmAcpClient.toBytes32(params.reason),
        params.optParams ?? "0x",
      ])
    );
  }

  override async reject(params: RejectParams): Promise<PreparedEvmTx> {
    return this.wrap(
      this.buildContractCall("reject", [
        BigInt(params.jobId),
        EvmAcpClient.toBytes32(params.reason),
        params.optParams ?? "0x",
      ])
    );
  }

  override async getJobIdFromTxHash(
    txHash: string,
    filter?: JobCreatedFilter
  ): Promise<bigint | null> {
    const receipt = await this.provider.getTransactionReceipt(
      txHash as Address
    );
    return parseJobIdFromReceipt(
      receipt,
      this.contractAddress as Address,
      filter
    );
  }

  override async getJob(
    chainId: number,
    jobId: bigint
  ): Promise<OnChainJob | null> {
    const result = await this.provider.readContract({
      address: this.contractAddress as Address,
      abi: ACP_ABI as readonly unknown[],
      functionName: "getJob",
      args: [jobId],
    });
    if (!result || typeof result !== "object" || !("id" in result)) return null;
    const raw = result as {
      id: bigint;
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
      id: raw.id,
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

  override async getTokenDecimals(tokenAddress: string): Promise<number> {
    const result = await this.provider.readContract({
      address: tokenAddress as Address,
      abi: erc20Abi,
      functionName: "decimals",
    });
    return Number(result);
  }

  private static toBytes32(value: string): Hex {
    if (value.startsWith("0x") && value.length === 66) return value as Hex;
    const hex = toHex(value);
    if (hex.length <= 66) return pad(hex, { size: 32, dir: "right" });
    return keccak256(hex);
  }

  private buildContractCall(
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
      to: this.contractAddress as Address,
      data,
      value: 0n,
    };
  }

  private wrap(call: Call): PreparedEvmTx {
    const context = this.getNetworkContext();
    return {
      tx: [call],
      chain: "evm",
      network: context.network,
    };
  }
}
