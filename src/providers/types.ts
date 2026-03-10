import type { Address, Call, TransactionReceipt } from "viem";

import type { NetworkContext, SolanaCluster } from "../core/chains";

export type SolanaInstructionLike = {
  programId: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: Uint8Array | string;
};

export interface IProviderAdapter {
  readonly providerName: string;
  getAddress(): Promise<string>;
  getNetworkContext(): Promise<NetworkContext>;
}

export type ReadContractParams = {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

export interface IEvmProviderAdapter extends IProviderAdapter {
  getAddress(): Promise<Address>;
  getChainId(): Promise<number>;
  sendCalls(calls: Call[]): Promise<Address | Address[]>;
  getTransactionReceipt(hash: Address): Promise<TransactionReceipt>;
  readContract(params: ReadContractParams): Promise<unknown>;
}

export interface ISolanaProviderAdapter extends IProviderAdapter {
  getAddress(): Promise<string>;
  getCluster(): Promise<SolanaCluster>;
  sendInstructions(
    instructions: SolanaInstructionLike[]
  ): Promise<string | string[]>;
}
