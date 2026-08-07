import type { Address, Call, Log, TransactionReceipt } from "viem";
import {
  AccountRole,
  type Commitment,
  type Rpc,
  type SolanaRpcApi,
  type KeyPairSigner,
  type Address as SolanaAddress,
} from "@solana/kit";

import type { NetworkContext, SolanaCluster } from "../core/chains.js";

// A Solana signer that can partially sign transactions and messages.
// KeyPairSigner (local keys) satisfies this, as do remote signers (e.g. Privy).
export type SolanaSigner = Pick<
  KeyPairSigner,
  "address" | "signTransactions" | "signMessages"
>;

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
  sendTransaction(chainId: number, call: Call | Call[]): Promise<Address>;
  sendCalls(chainId: number, calls: Call[]): Promise<Address | Address[]>;
  getTransactionReceipt(
    chainId: number,
    hash: Address,
  ): Promise<TransactionReceipt>;
  readContract(chainId: number, params: ReadContractParams): Promise<unknown>;
  getLogs(chainId: number, params: GetLogsParams): Promise<Log[]>;
  getBlockNumber(chainId: number): Promise<bigint>;
  signMessage(chainId: number, message: string): Promise<string>;
  signTypedData(chainId: number, typedData: unknown): Promise<string>;
}

export type SendInstructionsOptions = {
  /**
   * Consulted by sponsored (fee-payer) retry logic for guarded errors such
   * as WrongStatus: return true when the caller's own read RPC confirms the
   * transaction's state precondition is met (sponsor-node lag — retry), false
   * when the error is genuine (fail fast). See
   * providers/solana/feePayerRetry.ts. Adapters without sponsored retry may
   * ignore it.
   */
  retryGuard?: (error: unknown) => Promise<boolean> | boolean;
  preflightCommitment?: Commitment;
};

// Cluster-dependent methods take a chainId (500 = devnet, 501 = mainnet),
// mirroring IEvmProviderAdapter — one adapter can serve several clusters.
// getSigner/signMessage stay chainId-free: the signer is one keypair valid on
// every cluster and Solana message signing has no chain binding.
export interface ISolanaProviderAdapter extends IProviderAdapter {
  getAddress(): Promise<string>;
  getCluster(chainId: number): Promise<SolanaCluster>;
  getRpc(chainId: number): Rpc<SolanaRpcApi>;
  getSigner(): SolanaSigner;
  signMessage(message: string): Promise<string>;
  sendInstructions(
    chainId: number,
    instructions: SolanaInstructionLike[],
    options?: SendInstructionsOptions,
  ): Promise<string | string[]>;
}
