import { LocalAccountSigner, type SmartAccountSigner } from "@aa-sdk/core";
import { alchemy, defineAlchemyChain } from "@account-kit/infra";
import {
  createModularAccountV2Client,
  ModularAccountV2Client,
} from "@account-kit/smart-contracts";
import type { Address, Call, Chain, Hex, Log, TransactionReceipt } from "viem";
import { Attribution } from "ox/erc8021";
import { createEvmNetworkContext, EVM_MAINNET_CHAINS } from "../../core/chains";
import type {
  GetLogsParams,
  IEvmProviderAdapter,
  ReadContractParams,
} from "../types";
import { appendBuilderCodeData } from "./privyAlchemyEvmProviderAdapter";

export interface AlchemyChainConfig {
  chains?: Chain[];
  walletAddress: Address;
  privateKey: Hex;
  entityId: number;
  builderCode?: string;
}

export class AlchemyEvmProviderAdapter implements IEvmProviderAdapter {
  public readonly providerName: string = "Alchemy";
  public readonly address: Address;
  private readonly clients: Map<number, ModularAccountV2Client>;
  private readonly builderCodeSuffix: Hex | undefined;

  private constructor(
    address: Address,
    clients: Map<number, ModularAccountV2Client>,
    builderCode?: string
  ) {
    this.address = address;
    this.clients = clients;
    this.builderCodeSuffix = builderCode
      ? Attribution.toDataSuffix({ codes: [builderCode] })
      : undefined;
  }

  static async create(
    params: AlchemyChainConfig
  ): Promise<AlchemyEvmProviderAdapter> {
    const clients = new Map<number, ModularAccountV2Client>();

    const { chains = EVM_MAINNET_CHAINS } = params;

    const alchemyChains = chains.map((chain) =>
      defineAlchemyChain({
        chain: chain,
        rpcBaseUrl: `https://alchemy-proxy.virtuals.io/api/proxy/rpc?chainId=${chain.id}`,
      })
    );

    for (const chain of alchemyChains) {
      const signer: SmartAccountSigner =
        LocalAccountSigner.privateKeyToAccountSigner(params.privateKey);

      const client = await createModularAccountV2Client({
        chain: chain,
        transport: alchemy({
          rpcUrl: "https://alchemy-proxy.virtuals.io/api/proxy/rpc",
        }),
        signer,
        policyId: "186aaa4a-5f57-4156-83fb-e456365a8820",
        accountAddress: params.walletAddress,
        signerEntity: {
          entityId: params.entityId,
          isGlobalValidation: true,
        },
      });

      clients.set(client.chain.id, client);
    }

    const address = params.walletAddress;
    return new AlchemyEvmProviderAdapter(address, clients, params.builderCode);
  }

  private getClient(chainId: number): ModularAccountV2Client {
    const c = this.clients.get(chainId);
    if (!c)
      throw new Error(
        `AlchemyEvmProviderAdapter: no client configured for chainId ${chainId}`
      );
    return c;
  }

  async getAddress(): Promise<Address> {
    return this.address;
  }

  async getSupportedChainIds(): Promise<number[]> {
    return Array.from(this.clients.keys());
  }

  async getNetworkContext(chainId: number) {
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

  async sendCalls(
    chainId: number,
    _calls: Call[]
  ): Promise<Address | Address[]> {
    const client = this.getClient(chainId);
    const suffix = this.builderCodeSuffix;
    const { hash } = await client.sendUserOperation({
      uo: _calls.map((call) => ({
        target: call.to,
        data: suffix
          ? appendBuilderCodeData(call.data ?? "0x", suffix)
          : call.data ?? "0x",
        ...(call.value != null && { value: call.value }),
      })),
      overrides: {
        nonceKey: this.getRandomNonce(),
      },
    });

    const receiptHash = await client.waitForUserOperationTransaction({
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

  async getTransactionReceipt(
    chainId: number,
    hash: Address
  ): Promise<TransactionReceipt> {
    return this.getClient(chainId).getTransactionReceipt({ hash });
  }

  async readContract(
    chainId: number,
    params: ReadContractParams
  ): Promise<unknown> {
    return this.getClient(chainId).readContract(params);
  }

  async getLogs(chainId: number, params: GetLogsParams): Promise<Log[]> {
    const client = this.getClient(chainId);
    return client.getFilterLogs({
      filter: await client.createEventFilter({
        address: params.address,
        events: params.events as any,
        fromBlock: params.fromBlock,
        toBlock: params.toBlock ?? "latest",
      }),
    });
  }

  async getBlockNumber(chainId: number): Promise<bigint> {
    return this.getClient(chainId).getBlockNumber();
  }

  async signMessage(chainId: number, _message: string): Promise<string> {
    return this.getClient(chainId).signMessage({ message: _message });
  }

  async signTypedData(chainId: number, typedData: unknown): Promise<string> {
    return this.getClient(chainId).signTypedData(typedData as any);
  }
}
