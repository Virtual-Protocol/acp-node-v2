import { LocalAccountSigner, type SmartAccountSigner } from "@aa-sdk/core";
import { alchemy } from "@account-kit/infra";
import {
  createModularAccountV2Client,
  ModularAccountV2Client,
} from "@account-kit/smart-contracts";
import type { Address, Call, Chain, Hex, Log, TransactionReceipt } from "viem";
import { createEvmNetworkContext } from "../../core/chains";
import type {
  GetLogsParams,
  IEvmProviderAdapter,
  ReadContractParams,
} from "../types";

interface AlchemyEvmProviderAdapterParams {
  walletAddress: Address;
  privateKey: Hex;
  entityId: number;
  chain: Chain;
}

export class AlchemyEvmProviderAdapter implements IEvmProviderAdapter {
  public readonly providerName: string = "Alchemy";
  public readonly address: Address;
  public readonly chainId: number;
  public readonly client: ModularAccountV2Client;

  constructor(
    address: Address,
    chainId: number,
    client: ModularAccountV2Client
  ) {
    this.address = address;
    this.chainId = chainId;
    this.client = client;
  }

  static async create(
    params: AlchemyEvmProviderAdapterParams
  ): Promise<AlchemyEvmProviderAdapter> {
    const sessionKeySigner: SmartAccountSigner =
      LocalAccountSigner.privateKeyToAccountSigner(params.privateKey);

    const client = await createModularAccountV2Client({
      chain: params.chain,
      transport: alchemy({
        rpcUrl: "https://alchemy-proxy.virtuals.io/api/proxy/rpc",
      }),
      signer: sessionKeySigner,
      policyId: "186aaa4a-5f57-4156-83fb-e456365a8820",
      accountAddress: params.walletAddress,
      signerEntity: {
        entityId: params.entityId,
        isGlobalValidation: true,
      },
    });

    const provider = new AlchemyEvmProviderAdapter(
      client.account.address,
      client.chain.id,
      client
    );
    return provider;
  }

  async getAddress(): Promise<Address> {
    return this.address;
  }

  async getChainId(): Promise<number> {
    return this.chainId;
  }

  async getNetworkContext() {
    const chainId = await this.getChainId();
    return createEvmNetworkContext(chainId);
  }

  private getRandomNonce(bits = 152) {
    const bytes = bits / 8;
    const array = new Uint8Array(bytes);
    crypto.getRandomValues(array);

    let hex = Array.from(array, (b) => b.toString(16).padStart(2, "0")).join(
      ""
    );
    return BigInt("0x" + hex);
  }

  async sendCalls(_calls: Call[]): Promise<Address | Address[]> {
    const { hash } = await this.client.sendUserOperation({
      uo: _calls.map((call) => ({
        target: call.to,
        data: call.data ?? "0x",
        ...(call.value != null && { value: call.value }),
      })),
      overrides: {
        nonceKey: this.getRandomNonce(),
      },
    });

    const receiptHash = await this.client.waitForUserOperationTransaction({
      hash,
      tag: "pending",
      retries: {
        intervalMs: 200,
        multiplier: 1.1,
        maxRetries: 10,
      },
    });

    return receiptHash;
  }

  async getTransactionReceipt(hash: Address): Promise<TransactionReceipt> {
    return this.client.getTransactionReceipt({ hash });
  }

  async readContract(params: ReadContractParams): Promise<unknown> {
    return this.client.readContract(params);
  }

  async getLogs(params: GetLogsParams): Promise<Log[]> {
    return this.client.getFilterLogs({
      filter: await this.client.createEventFilter({
        address: params.address,
        events: params.events as any,
        fromBlock: params.fromBlock,
        toBlock: params.toBlock ?? "latest",
      }),
    });
  }

  async getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  async signMessage(_message: string): Promise<string> {
    return this.client.signMessage({ message: _message });
  }
}
