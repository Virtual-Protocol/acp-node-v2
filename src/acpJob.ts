import type { Hex } from "viem";
import type { OnChainJob } from "./core/operations";
import { Erc20Token } from "./core/erc20Token";
import type { AcpAgent } from "./acpAgent";
import type {
  SetFundTransferBudgetParams,
  FundWithTransferParams,
  SubmitWithTransferParams,
} from "./acpAgent";

export class AcpJob {
  readonly id: bigint;
  readonly clientAddress: string;
  readonly providerAddress: string;
  readonly evaluatorAddress: string;
  readonly description: string;
  readonly budget: bigint;
  readonly expiredAt: bigint;
  readonly status: number;
  readonly hookAddress: string;

  private readonly agent: AcpAgent;

  constructor(agent: AcpAgent, data: OnChainJob) {
    this.agent = agent;
    this.id = data.id;
    this.clientAddress = data.client;
    this.providerAddress = data.provider;
    this.evaluatorAddress = data.evaluator;
    this.description = data.description;
    this.budget = data.budget;
    this.expiredAt = data.expiredAt;
    this.status = data.status;
    this.hookAddress = data.hook;
  }

  setBudget(params: {
    amount: Erc20Token;
    optParams?: Hex;
  }): Promise<string | string[]> {
    return this.agent.setBudget({
      jobId: this.id,
      amount: params.amount,
      optParams: params.optParams ?? "0x",
    });
  }

  setFundTransferBudget(
    params: Omit<SetFundTransferBudgetParams, "jobId">
  ): Promise<string | string[]> {
    return this.agent.setFundTransferBudget({
      jobId: this.id,
      ...params,
    });
  }

  fund(params: { amount: Erc20Token }): Promise<string | string[]> {
    return this.agent.fund({
      jobId: this.id,
      amount: params.amount,
    });
  }

  fundWithTransfer(
    params: Omit<FundWithTransferParams, "jobId">
  ): Promise<string | string[]> {
    return this.agent.fundWithTransfer({
      jobId: this.id,
      ...params,
    });
  }

  submit(params: {
    deliverable: string;
    optParams?: Hex;
  }): Promise<string | string[]> {
    return this.agent.submit({
      jobId: this.id,
      deliverable: params.deliverable,
      optParams: params.optParams ?? "0x",
    });
  }

  submitWithTransfer(
    params: Omit<SubmitWithTransferParams, "jobId">
  ): Promise<string | string[]> {
    return this.agent.submitWithTransfer({
      jobId: this.id,
      ...params,
    });
  }

  complete(params: {
    reason: string;
    optParams?: Hex;
  }): Promise<string | string[]> {
    return this.agent.complete({
      jobId: this.id,
      reason: params.reason,
      optParams: params.optParams ?? "0x",
    });
  }

  reject(params: {
    reason: string;
    optParams?: Hex;
  }): Promise<string | string[]> {
    return this.agent.reject({
      jobId: this.id,
      reason: params.reason,
      optParams: params.optParams ?? "0x",
    });
  }
}
