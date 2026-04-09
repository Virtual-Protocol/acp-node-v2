import type {
  Address,
  Call,
  Log,
  PublicClient,
  TransactionReceipt,
} from "viem";

import { createEvmNetworkContext } from "../../core/chains";
import type {
  GetLogsParams,
  IEvmProviderAdapter,
  ReadContractParams,
} from "../types";

export class ViemProviderAdapter implements IEvmProviderAdapter {
  public readonly providerName: string;

  constructor(providerName: string) {
    this.providerName = providerName;
  }

  getPublicClient(chainId: number): PublicClient {
    throw new Error("getPublicClient() not implemented. Override in subclass.");
  }

  async getAddress(): Promise<Address> {
    throw new Error("getAddress() not implemented. Override in subclass.");
  }

  async getSupportedChainIds(): Promise<number[]> {
    throw new Error(
      "getSupportedChainIds() not implemented. Override in subclass."
    );
  }

  async getNetworkContext(chainId: number) {
    return createEvmNetworkContext(chainId);
  }

  async sendCalls(
    _chainId: number,
    _calls: Call[]
  ): Promise<Address | Address[]> {
    throw new Error("sendCalls() not implemented. Override in subclass.");
  }

  async getTransactionReceipt(
    _chainId: number,
    _hash: Address
  ): Promise<TransactionReceipt> {
    throw new Error(
      "getTransactionReceipt() not implemented. Override in subclass."
    );
  }

  async readContract(
    _chainId: number,
    _params: ReadContractParams
  ): Promise<unknown> {
    throw new Error("readContract() not implemented. Override in subclass.");
  }

  async getLogs(_chainId: number, _params: GetLogsParams): Promise<Log[]> {
    throw new Error("getLogs() not implemented. Override in subclass.");
  }

  async getBlockNumber(_chainId: number): Promise<bigint> {
    throw new Error("getBlockNumber() not implemented. Override in subclass.");
  }

  async signMessage(_chainId: number, _message: string): Promise<string> {
    throw new Error("signMessage() not implemented. Override in subclass.");
  }

  async signTypedData(_chainId: number, _typedData: unknown): Promise<string> {
    throw new Error("signTypedData() not implemented. Override in subclass.");
  }
}
