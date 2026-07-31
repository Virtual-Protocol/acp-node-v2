import type { Address, Call, Log, TransactionReceipt } from "viem";
import {
  AccountRole,
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
  /**
   * Additional required signers beyond the adapter's own signer (e.g. the
   * provider co-signing a multi-hook complete). Presence forces the SELF-PAY
   * path: the sponsored flow adds only this wallet's signature and cannot
   * carry a second required signer, so the adapter's signer pays the fee.
   */
  extraSigners?: SolanaSigner[];
  /**
   * Address lookup tables to compress the transaction against, keyed by
   * table address with the table's ON-CHAIN address ordering as the value
   * (see core/solana/lookupTable.ts — never compress against a local list).
   * By default, presence forces the SELF-PAY path (see extraSigners); pass
   * `sponsorLookupTables` to instead compress inside the sponsored flow.
   */
  lookupTables?: Record<string, SolanaAddress[]>;
  /**
   * Option B — sponsor a lookup-table-compressed and/or multi-signer
   * transaction instead of self-paying it. When true, the sponsored path
   * compresses against `lookupTables` before requesting the fee payer (Alchemy
   * supports versioned v0 txs, so the ALT resolves during its simulation; the
   * propagation lag is absorbed by the fee-payer retry), and each
   * `extraSigners` entry partial-signs after Alchemy + Privy (Alchemy sponsors
   * two-signer txs). Caller is responsible for having created and warmed any
   * table on-chain first.
   */
  sponsorLookupTables?: boolean;
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
  sendInstructions(
    chainId: number,
    instructions: SolanaInstructionLike[],
    options?: SendInstructionsOptions,
  ): Promise<string | string[]>;
}
