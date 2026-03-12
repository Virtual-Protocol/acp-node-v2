import type { OnChainJob } from "./core/operations";

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

  constructor(data: OnChainJob) {
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
}
