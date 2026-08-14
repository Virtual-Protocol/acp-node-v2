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
  /**
   * Additional required signers beyond the adapter's own signer (e.g. the
   * provider co-signing a multi-hook complete). Applied on EVERY send path —
   * sponsored, self-pay and Kora SPL-paid alike. Sponsorship is chosen by
   * whether the batch touches an ACP program, never by these options.
   */
  extraSigners?: SolanaSigner[];
  /**
   * Address lookup tables to compress the transaction against, keyed by
   * table address with the table's ON-CHAIN address ordering as the value
   * (see core/solana/lookupTable.ts — never compress against a local list).
   * Compression is applied on every send path, and always before any size
   * check: a router `complete` fits only once compressed. The caller is
   * responsible for having created and warmed the table on-chain first.
   */
  lookupTables?: Record<string, SolanaAddress[]>;
  /**
   * Hook-PDA rents for this action were pre-created in a direct sponsored
   * transaction at CPI height 2 (see core/solana/preCreate.ts). A zero rent
   * prefund on the main transaction is then the EXPECTED outcome, so adapters
   * suppress the router zero-prefund warning.
   */
  hookRentPreCreated?: boolean;
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
  /**
   * Address that should fund rent for accounts a transaction creates (notably
   * ATAs). Defaults to the wallet's own signer, so a self-paying wallet funds
   * its own rent in SOL. Adapters that route non-ACP transactions through an
   * SPL paymaster (e.g. Kora) return the paymaster's fee-payer here, so the
   * paymaster fronts the rent in SOL and bills the user in SPL. Pass the result
   * as the `payer` argument to the wallet.ts instruction builders.
   */
  getRentPayer(chainId: number): Promise<string>;
  sendInstructions(
    chainId: number,
    instructions: SolanaInstructionLike[],
    options?: SendInstructionsOptions,
  ): Promise<string | string[]>;
}
