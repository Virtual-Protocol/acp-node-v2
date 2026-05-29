import type { Address, Call, Log, TransactionReceipt } from "viem";

import type { NetworkContext, SolanaCluster } from "../core/chains.js";

/**
 * Call shape accepted by sendTransaction / sendCalls. Extends viem's Call
 * with an optional `gas` field so callers can override the wallet's
 * gas-limit estimate (useful when an aggregator like LiFi already
 * supplies a padded recommended gas limit and the bundler's default
 * estimate runs too tight).
 *
 * Pass-through is best-effort: implementations forward `gas` to the
 * underlying viem/Alchemy client. If a particular backend ignores it,
 * the bundler falls back to its own estimate (current behaviour).
 */
export type EvmCall = Call<unknown, { gas?: bigint }>;

export type SolanaInstructionLike = {
  programId: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: Uint8Array | string;
};

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
  sendTransaction(chainId: number, call: EvmCall): Promise<Address>;
  sendCalls(chainId: number, calls: EvmCall[]): Promise<Address | Address[]>;
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
  sendInstructions(
    instructions: SolanaInstructionLike[]
  ): Promise<string | string[]>;
}
