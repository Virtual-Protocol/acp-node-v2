import type { Address, Call, TransactionReceipt } from "viem";

import { createEvmNetworkContext } from "../../core/chains";
import type { IEvmProviderAdapter, ReadContractParams } from "../types";

export class ViemProviderAdapter implements IEvmProviderAdapter {
  public readonly providerName: string;

  constructor(providerName: string) {
    this.providerName = providerName;
  }

  async getAddress(): Promise<Address> {
    throw new Error("getAddress() not implemented. Override in subclass.");
  }

  async getChainId(): Promise<number> {
    throw new Error("getChainId() not implemented. Override in subclass.");
  }

  async getNetworkContext() {
    const chainId = await this.getChainId();
    return createEvmNetworkContext(chainId);
  }

  async sendCalls(_calls: Call[]): Promise<Address | Address[]> {
    throw new Error("sendCalls() not implemented. Override in subclass.");
  }

  async getTransactionReceipt(_hash: Address): Promise<TransactionReceipt> {
    throw new Error(
      "getTransactionReceipt() not implemented. Override in subclass."
    );
  }

  async readContract(_params: ReadContractParams): Promise<unknown> {
    throw new Error("readContract() not implemented. Override in subclass.");
  }
}
