import { encodeAbiParameters, type Address, type Hex } from "viem";
import {
  type AcpClient,
  type CreateAcpClientInput,
  createAcpClient,
} from "./clientFactory";
import type {
  CompleteParams,
  CreateJobParams,
  RejectParams,
  SubmitParams,
} from "./core/operations";
import { FUND_TRANSFER_HOOK_ADDRESS } from "./core/constants";
import { Erc20Token } from "./core/erc20Token";
import { AcpJob } from "./acpJob";
import { PollingTransport } from "./events/pollingTransport";
import type {
  AcpEventHandlers,
  AcpTransport,
  TransportContext,
} from "./events/types";

export type SetBudgetParams = {
  jobId: bigint;
  amount: Erc20Token;
  optParams?: Hex;
};

export type FundJobParams = {
  jobId: bigint;
  amount: Erc20Token;
};

export type SetFundTransferBudgetParams = {
  jobId: bigint;
  amount: Erc20Token;
  transferAmount: Erc20Token;
  destination: string;
  subExpiry?: bigint;
  packageId?: bigint;
};

export type FundWithTransferParams = {
  jobId: bigint;
  amount: Erc20Token;
  transferAmount: Erc20Token;
  targetIntentId: bigint;
  hookAddress?: string;
};

export type SubmitWithTransferParams = {
  jobId: bigint;
  deliverable: string;
  transferAmount: Erc20Token;
  hookAddress?: string;
};

export class AcpAgent {
  private readonly client: AcpClient;

  constructor(client: AcpClient) {
    this.client = client;
  }

  static async create(input: CreateAcpClientInput): Promise<AcpAgent> {
    const client = await createAcpClient(input);
    return new AcpAgent(client);
  }

  getClient(): AcpClient {
    return this.client;
  }

  async getAddress(): Promise<string> {
    return this.client.getAddress();
  }

  async listen(
    handlers: AcpEventHandlers,
    transport?: AcpTransport
  ): Promise<() => void> {
    const t = transport ?? new PollingTransport();
    const ctx: TransportContext = {
      agentAddress: await this.getAddress(),
      contractAddress: this.client.getContractAddress(),
      client: this.client,
      agent: this,
    };
    await t.start(ctx, handlers);
    return () => t.stop();
  }

  async resolveToken(address: string, amount: number): Promise<Erc20Token> {
    return Erc20Token.fromOnChain(address, amount, this.client);
  }

  async createJob(params: CreateJobParams): Promise<AcpJob> {
    const prepared = await this.client.createJob(params);
    const result = await this.client.submitPrepared([prepared]);
    const txHash = Array.isArray(result) ? result[0]! : result;
    const jobId = await this.client.getJobIdFromTxHash(txHash);
    if (!jobId) throw new Error("Failed to extract job ID from transaction");
    return this.getJobById(jobId);
  }

  async createFundTransferJob(params: CreateJobParams): Promise<AcpJob> {
    return this.createJob({
      ...params,
      hookAddress: params.hookAddress ?? FUND_TRANSFER_HOOK_ADDRESS,
    });
  }

  async getJobById(jobId: bigint): Promise<AcpJob> {
    const data = await this.client.getJob(jobId);
    if (!data) throw new Error(`Job not found: ${jobId}`);
    return new AcpJob(this, data);
  }

  async setBudget(params: SetBudgetParams): Promise<string | string[]> {
    const prepared = await this.client.setBudget({
      jobId: params.jobId,
      amount: params.amount.rawAmount,
      optParams: params.optParams ?? "0x",
    });
    return this.client.submitPrepared([prepared]);
  }

  async setFundTransferBudget(
    params: SetFundTransferBudgetParams
  ): Promise<string | string[]> {
    const optParams = encodeAbiParameters(
      [
        { type: "address", name: "token" },
        { type: "uint256", name: "amount" },
        { type: "address", name: "destination" },
        { type: "uint256", name: "subExpiry" },
        { type: "uint256", name: "packageId" },
      ],
      [
        params.transferAmount.address as Address,
        params.transferAmount.rawAmount,
        params.destination as Address,
        params.subExpiry ?? 0n,
        params.packageId ?? 0n,
      ]
    );

    return this.setBudget({
      jobId: params.jobId,
      amount: params.amount,
      optParams,
    });
  }

  async fund(params: FundJobParams): Promise<string | string[]> {
    const approvePrepared = await this.client.approveAllowance({
      tokenAddress: params.amount.address,
      spenderAddress: this.client.getContractAddress(),
      amount: params.amount.rawAmount,
    });

    const fundPrepared = await this.client.fund({
      jobId: params.jobId,
    });

    return this.client.submitPrepared([approvePrepared, fundPrepared]);
  }

  async fundWithTransfer(
    params: FundWithTransferParams
  ): Promise<string | string[]> {
    const approveAcp = await this.client.approveAllowance({
      tokenAddress: params.amount.address,
      spenderAddress: this.client.getContractAddress(),
      amount: params.amount.rawAmount,
    });

    const hookAddr = params.hookAddress ?? FUND_TRANSFER_HOOK_ADDRESS;
    const approveHook = await this.client.approveAllowance({
      tokenAddress: params.transferAmount.address,
      spenderAddress: hookAddr,
      amount: params.transferAmount.rawAmount,
    });

    const optParams: Hex = encodeAbiParameters(
      [{ type: "uint256", name: "targetIntentId" }],
      [params.targetIntentId]
    );

    const fundPrepared = await this.client.fund({
      jobId: params.jobId,
      optParams,
    });

    return this.client.submitPrepared([approveAcp, approveHook, fundPrepared]);
  }

  async submit(params: SubmitParams): Promise<string | string[]> {
    const prepared = await this.client.submit(params);
    return this.client.submitPrepared([prepared]);
  }

  async submitWithTransfer(
    params: SubmitWithTransferParams
  ): Promise<string | string[]> {
    const hookAddr = params.hookAddress ?? FUND_TRANSFER_HOOK_ADDRESS;
    const approvePrepared = await this.client.approveAllowance({
      tokenAddress: params.transferAmount.address,
      spenderAddress: hookAddr,
      amount: params.transferAmount.rawAmount,
    });

    const optParams: Hex = encodeAbiParameters(
      [
        { type: "address", name: "token" },
        { type: "uint256", name: "amount" },
      ],
      [
        params.transferAmount.address as Address,
        params.transferAmount.rawAmount,
      ]
    );

    const submitPrepared = await this.client.submit({
      jobId: params.jobId,
      deliverable: params.deliverable,
      optParams,
    });

    return this.client.submitPrepared([approvePrepared, submitPrepared]);
  }

  async complete(params: CompleteParams): Promise<string | string[]> {
    const prepared = await this.client.complete(params);
    return this.client.submitPrepared([prepared]);
  }

  async reject(params: RejectParams): Promise<string | string[]> {
    const prepared = await this.client.reject(params);
    return this.client.submitPrepared([prepared]);
  }
}
