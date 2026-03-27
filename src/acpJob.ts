import type { Address } from "viem";
import { AssetToken } from "./core/assetToken";
import type { AcpClient } from "./clientFactory";
import type { OnChainJob } from "./core/operations";
import type { OffChainIntent, OffChainJob } from "./events/types";

const STATUS_MAP: Record<string, number> = {
  OPEN: 0,
  FUNDED: 1,
  SUBMITTED: 2,
  COMPLETED: 3,
  REJECTED: 4,
  EXPIRED: 5,
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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
  readonly status: number;
  readonly hookAddress: string;
  readonly intents: AcpIntent[];

  constructor(chainId: number, data: OnChainJob, intents: AcpIntent[] = []) {
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
    this.intents = intents;
  }

  getFundRequestIntent(): AcpIntent | null {
    const intent = this.intents.find((i) => i.isEscrow);
    if (intent == null) return null;
    return intent;
  }

  getFundTransferIntent(): AcpIntent | null {
    const intent = this.intents.find((i) => !i.isEscrow);
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
        status: STATUS_MAP[data.jobStatus] ?? 0,
        hook: data.hookAddress ?? ZERO_ADDRESS,
      },
      intents
    );
  }
}
