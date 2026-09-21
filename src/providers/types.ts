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
   * Consulted by sponsored retry logic for guarded errors: true when the
   * caller's own read RPC confirms the state precondition, false when the
   * error is genuine. Adapters without sponsored retry may ignore it.
   */
  retryGuard?: (error: unknown) => Promise<boolean> | boolean;
  /**
   * Error names/codes this send is EXPECTED to fail with (negative tests).
   * A failure matching one of them propagates immediately instead of being
   * treated as sponsor-node lag.
   *
   * Matched case-insensitively against the flattened error chain.
   * See providers/solana/feePayerRetry.ts.
   */
  expectedErrors?: string[];
  /**
   * The rent shard this transaction's job is pinned to. When set, the
   * sponsored path names THIS wallet as fee payer rather than whichever payer
   * the rotation last handed out, so the payer that prefunds a job is the
   * shard that receives the rent back.
   *
   * Only valid for a member of the signer pool; use
   * `sponsorForRecorded(acpState, job.shardIndex)`. Ignored on self-paid
   * sends, and a no-op at one shard.
   */
  sponsorShard?: SolanaAddress;
  preflightCommitment?: Commitment;
  /**
   * Required signers beyond the adapter's own. Presence forces the SELF-PAY
   * path, since the sponsored flow adds only this wallet's signature.
   */
  extraSigners?: SolanaSigner[];
  /**
   * Lookup tables to compress against, keyed by table address with the table's
   * ON-CHAIN ordering as the value — never a local list. Presence forces the
   * SELF-PAY path unless `sponsorLookupTables` is set.
   */
  lookupTables?: Record<string, SolanaAddress[]>;
  /**
   * Sponsor a lookup-table-compressed and/or multi-signer transaction instead
   * of self-paying it: the sponsored path compresses against `lookupTables`
   * before requesting the fee payer, and each `extraSigners` entry
   * partial-signs afterwards. The caller must have created and warmed any
   * table on-chain first.
   */
  sponsorLookupTables?: boolean;
  /**
   * Hook-PDA rents for this action were pre-created in a direct transaction
   * (see core/solana/preCreate.ts), making a zero rent prefund on the main
   * transaction the expected outcome.
   */
  hookRentPreCreated?: boolean;
};

// Cluster-dependent methods take a chainId, so one adapter can serve several
// clusters. getSigner/signMessage stay chainId-free: one keypair is valid
// everywhere and Solana message signing has no chain binding.
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
