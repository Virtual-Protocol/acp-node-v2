import { zeroAddress, type Address } from "viem";
import { AssetToken } from "./core/assetToken.js";
import type { AcpClient } from "./clientFactory.js";
import type { OnChainJob } from "./core/operations.js";
import {
  AcpJobStatus,
  type OffChainIntent,
  type OffChainJob,
  type OffChainSubscription,
} from "./events/types.js";
import { JobStatus } from "./clients/baseAcpClient.js";

function statusFromOnChain(n: number): AcpJobStatus {
  const name = JobStatus[n] as keyof typeof AcpJobStatus | undefined;
  if (!name) throw new Error(`Unknown on-chain job status: ${n}`);
  return AcpJobStatus[name];
}

function statusToOnChain(s: AcpJobStatus): number {
  const code = JobStatus[s as unknown as keyof typeof JobStatus];
  if (code == null) throw new Error(`Unknown job status: ${s}`);
  return code;
}

export class AcpIntent {
  readonly intentId: string;
  readonly actor: string;
  readonly isEscrow: boolean;
  readonly isSigned: boolean;
  readonly fromAddress: string;
  readonly recipientAddress: string;
  readonly rawAmount: bigint | null;
  readonly tokenAddress: string | null;

  constructor(data: OffChainIntent) {
    this.intentId = data.intentId;
    this.actor = data.actor;
    this.isEscrow = data.isEscrow;
    this.isSigned = data.isSigned;
    this.fromAddress = data.fromAddress;
    this.recipientAddress = data.recipientAddress;
    this.rawAmount = data.amount != null ? BigInt(data.amount) : null;
    this.tokenAddress = data.tokenAddress;
  }

  async resolveAmount(
    chainId: number,
    client: AcpClient
  ): Promise<AssetToken | null> {
    if (this.rawAmount == null || this.tokenAddress == null) return null;
    return AssetToken.fromOnChainRaw(
      this.tokenAddress as Address,
      this.rawAmount,
      chainId,
      client
    );
  }
}

export class AcpJob {
  readonly chainId: number;
  readonly id: bigint;
  readonly clientAddress: string;
  readonly providerAddress: string;
  readonly evaluatorAddress: string;
  readonly description: string;
  readonly budget: AssetToken;
  readonly expiredAt: bigint;
  readonly status: AcpJobStatus;
  readonly hookAddress: string;
  readonly intents: AcpIntent[];
  readonly deliverable: string | null;
  readonly hookConfigs: Record<string, string[]> | null;
  readonly clientSubscription: OffChainSubscription | null;

  constructor(
    chainId: number,
    data: OnChainJob,
    intents: AcpIntent[] = [],
    deliverable: string | null = null,
    hookConfigs: Record<string, string[]> | null = null,
    clientSubscription: OffChainSubscription | null = null
  ) {
    this.chainId = chainId;
    this.id = data.id;
    this.clientAddress = data.client;
    this.providerAddress = data.provider;
    this.evaluatorAddress = data.evaluator;
    this.description = data.description;
    this.budget = AssetToken.usdcFromRaw(data.budget, chainId);
    this.expiredAt = data.expiredAt;
    this.status = statusFromOnChain(data.status);
    this.hookAddress = data.hook;
    this.intents = intents;
    this.deliverable = deliverable;
    this.hookConfigs = hookConfigs;
    this.clientSubscription = clientSubscription;
  }

  getFundRequestIntent(): AcpIntent | null {
    const intent = this.intents.find((i) => !i.isEscrow);
    if (intent == null) return null;
    return intent;
  }

  getFundTransferIntent(): AcpIntent | null {
    const intent = this.intents.find((i) => i.isEscrow);
    if (intent == null) return null;
    return intent;
  }

  static fromOffChain(data: OffChainJob): AcpJob {
    const intents = (data.intents ?? []).map((i) => new AcpIntent(i));
    return new AcpJob(
      data.chainId,
      {
        id: BigInt(data.onChainJobId),
        client: data.clientAddress,
        provider: data.providerAddress,
        evaluator: data.evaluatorAddress,
        description: data.description ?? "",
        budget: BigInt(data.budget ?? "0"),
        expiredAt: BigInt(
          Math.floor(new Date(data.expiredAt).getTime() / 1000)
        ),
        status: statusToOnChain(data.jobStatus),
        hook: data.hookAddress ?? zeroAddress,
      },
      intents,
      data.deliverable ?? null,
      data.hookConfigs ?? null,
      data.clientSubscription ?? null
    );
  }
}
