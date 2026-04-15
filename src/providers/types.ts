import type { Address, Call, Log, TransactionReceipt } from "viem";
import { AccountRole, type Rpc, type SolanaRpcApi, type KeyPairSigner, type Address as SolanaAddress } from "@solana/kit";

import type { NetworkContext, SolanaCluster } from "../core/chains";

// A Solana signer that can partially sign transactions and messages.
// KeyPairSigner (local keys) satisfies this, as do remote signers (e.g. Privy).
export type SolanaSigner = Pick<KeyPairSigner, 'address' | 'signTransactions' | 'signMessages'>;

export type SolanaInstructionLike = {
  programAddress: SolanaAddress;
  accounts: Array<{ address: SolanaAddress; role: AccountRole }>;
  data: Uint8Array;
};

export { AccountRole } from "@solana/kit";

export interface IProviderAdapter {
  readonly providerName: string;
  getAddress(): Promise<string>;
  getSupportedChainIds(): Promise<number[]>;
  getNetworkContext(chainId: number): Promise<NetworkContext>;
}

export type ReadContractParams = {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

export type GetLogsParams = {
  address: Address;
  events: readonly unknown[];
  fromBlock: bigint;
  toBlock?: bigint | "latest";
};

export interface IEvmProviderAdapter extends IProviderAdapter {
  getAddress(): Promise<Address>;
  sendCalls(chainId: number, calls: Call[]): Promise<Address | Address[]>;
  getTransactionReceipt(
    chainId: number,
    hash: Address
  ): Promise<TransactionReceipt>;
  readContract(chainId: number, params: ReadContractParams): Promise<unknown>;
  getLogs(chainId: number, params: GetLogsParams): Promise<Log[]>;
  getBlockNumber(chainId: number): Promise<bigint>;
  signMessage(chainId: number, message: string): Promise<string>;
  signTypedData(chainId: number, typedData: unknown): Promise<string>;
}

export interface ISolanaProviderAdapter extends IProviderAdapter {
  getAddress(): Promise<string>;
  getCluster(): Promise<SolanaCluster>;
  getRpc(): Rpc<SolanaRpcApi>;
  getSigner(): SolanaSigner;
  sendInstructions(
    instructions: SolanaInstructionLike[]
  ): Promise<string | string[]>;
}
