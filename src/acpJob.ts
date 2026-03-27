import { AssetToken } from "./core/assetToken";
import type { OnChainJob } from "./core/operations";
import type { OffChainJob } from "./events/types";

const STATUS_MAP: Record<string, number> = {
  OPEN: 0,
  FUNDED: 1,
  SUBMITTED: 2,
  COMPLETED: 3,
  REJECTED: 4,
  EXPIRED: 5,
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class AcpJob {
  readonly chainId: number;
  readonly id: bigint;
  readonly clientAddress: string;
  readonly providerAddress: string;
  readonly evaluatorAddress: string;
  readonly description: string;
  readonly budget: AssetToken;
  readonly expiredAt: bigint;
  readonly status: number;
  readonly hookAddress: string;

  constructor(chainId: number, data: OnChainJob) {
    this.chainId = chainId;
    this.id = data.id;
    this.clientAddress = data.client;
    this.providerAddress = data.provider;
    this.evaluatorAddress = data.evaluator;
    this.description = data.description;
    this.budget = AssetToken.usdcFromRaw(data.budget, chainId);
    this.expiredAt = data.expiredAt;
    this.status = data.status;
    this.hookAddress = data.hook;
  }

  static fromOffChain(data: OffChainJob): AcpJob {
    return new AcpJob(data.chainId, {
      id: BigInt(data.onChainJobId),
      client: data.clientAddress,
      provider: data.providerAddress,
      evaluator: data.evaluatorAddress,
      description: data.description ?? "",
      budget: BigInt(data.budget ?? "0"),
      expiredAt: BigInt(Math.floor(new Date(data.expiredAt).getTime() / 1000)),
      status: STATUS_MAP[data.jobStatus] ?? 0,
      hook: data.hookAddress ?? ZERO_ADDRESS,
    });
  }
}
