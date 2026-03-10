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
  SetBudgetParams,
  SubmitParams,
} from "./core/operations";

export type FundJobParams = {
  jobId: bigint;
  amount: bigint;
};

export type SetFundTransferBudgetParams = {
  jobId: bigint;
  amount: bigint;
  transferAmount: bigint;
  tokenAddress: string;
  destination: string;
  subExpiry?: bigint;
  packageId?: bigint;
};

export type FundWithTransferParams = {
  jobId: bigint;
  tokenAddress: string;
  acpAmount: bigint;
  hookAddress?: string;
  transferAmount: bigint;
  targetIntentId: bigint;
};

export type SubmitWithTransferParams = {
  jobId: bigint;
  deliverable: string;
  tokenAddress: string;
  hookAddress?: string;
  transferAmount: bigint;
};

const FUND_TRANSFER_HOOK_ADDRESS = "0x37F8D776D101094C2c0164803BfA0b731398E411";
const USDC_CONTRACT_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

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

  async createJob(params: CreateJobParams): Promise<bigint> {
    const prepared = await this.client.createJob(params);
    const result = await this.client.submitPrepared([prepared]);
    const txHash = Array.isArray(result) ? result[0]! : result;
    const jobId = await this.client.getJobIdFromTxHash(txHash);
    if (!jobId) throw new Error("Failed to extract job ID from transaction");
    return jobId;
  }

  async createFundTransferJob(params: CreateJobParams): Promise<bigint> {
    return this.createJob({
      ...params,
      hookAddress: params.hookAddress ?? FUND_TRANSFER_HOOK_ADDRESS,
    });
  }

  async setBudget(params: SetBudgetParams): Promise<string | string[]> {
    const prepared = await this.client.setBudget(params);
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
        params.tokenAddress as Address,
        params.transferAmount,
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
      tokenAddress: USDC_CONTRACT_ADDRESS,
      spenderAddress: this.client.getContractAddress(),
      amount: params.amount,
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
      tokenAddress: USDC_CONTRACT_ADDRESS,
      spenderAddress: this.client.getContractAddress(),
      amount: params.acpAmount,
    });

    const approveHook = await this.client.approveAllowance({
      tokenAddress: params.tokenAddress,
      spenderAddress: params.hookAddress ?? FUND_TRANSFER_HOOK_ADDRESS,
      amount: params.transferAmount,
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
    const approvePrepared = await this.client.approveAllowance({
      tokenAddress: params.tokenAddress,
      spenderAddress: params.hookAddress ?? FUND_TRANSFER_HOOK_ADDRESS,
      amount: params.transferAmount,
    });

    const optParams: Hex = encodeAbiParameters(
      [
        { type: "address", name: "token" },
        { type: "uint256", name: "amount" },
      ],
      [params.tokenAddress as Address, params.transferAmount]
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
