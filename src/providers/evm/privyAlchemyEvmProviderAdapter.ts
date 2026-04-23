import {
  concatHex,
  createWalletClient,
  http,
  LocalAccount,
  pad,
  toHex,
  TypedDataDefinition,
  type Address,
  type Call,
  type Chain,
  type Hex,
  type Log,
  type SignableMessage,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { Attribution } from "ox/erc8021";
import {
  getTransactionReceipt,
  readContract,
  getLogs,
  getBlockNumber,
} from "viem/actions";
import { createEvmNetworkContext, EVM_MAINNET_CHAINS } from "../../core/chains";
import type {
  GetLogsParams,
  IEvmProviderAdapter,
  ReadContractParams,
} from "../types";
import {
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
  WalletApiRequestSignatureInput,
} from "@privy-io/node";
import {
  createSmartWalletClient,
  type SmartWalletClient,
  alchemyWalletTransport,
} from "@alchemy/wallet-apis";
import { ACP_SERVER_URL, PRIVY_APP_ID } from "../../core/constants";
import { ProviderAuthClient } from "../providerAuthClient";

export type SignFn = (payload: Uint8Array) => Promise<string>;

export interface PrivyAlchemyChainConfig {
  chains?: Chain[];
  walletAddress: Address;
  walletId: string;
  signerPrivateKey?: string;
  signFn?: SignFn;
  serverUrl?: string;
  privyAppId?: string;
  builderCode?: string;
}

function encodeSignableMessage(message: SignableMessage): {
  message: string;
  encoding: "utf-8" | "hex";
} {
  if (typeof message === "string") {
    if (message.startsWith("0x")) {
      return { message: message.slice(2), encoding: "hex" };
    }
    return { message, encoding: "utf-8" };
  }
  const raw =
    typeof message.raw === "string" ? message.raw : toHex(message.raw);
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  return { message: hex, encoding: "hex" };
}

function buildSignInput(
  walletId: string,
  body: Record<string, unknown>,
  privyAppId: string = PRIVY_APP_ID
): WalletApiRequestSignatureInput {
  return {
    version: 1,
    method: "POST",
    url: `https://api.privy.io/v1/wallets/${walletId}/rpc`,
    body,
    headers: { "privy-app-id": privyAppId },
  };
}

async function serverPost<T>(
  path: string,
  body: unknown,
  serverUrl: string
): Promise<T> {
  const base = serverUrl.replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      data?.detail ?? data?.error ?? `Server error ${res.status}`
    );
  }
  return data as T;
}

async function signedServerCall<T>(
  executePath: string,
  walletId: string,
  rpcBody: Record<string, unknown>,
  payload: Record<string, unknown>,
  signerPrivateKey: string | undefined,
  serverUrl: string,
  privyAppId: string = PRIVY_APP_ID,
  signFn?: SignFn
): Promise<T> {
  const input = buildSignInput(walletId, rpcBody, privyAppId);
  let authorizationSignature: string;
  if (signFn) {
    const formatted = formatRequestForAuthorizationSignature(input);
    authorizationSignature = await signFn(formatted);
  } else if (signerPrivateKey) {
    authorizationSignature = generateAuthorizationSignature({
      authorizationPrivateKey: signerPrivateKey,
      input,
    });
  } else {
    throw new Error(
      "PrivyAlchemyEvmProviderAdapter: either signerPrivateKey or signFn must be provided"
    );
  }

  return serverPost<T>(
    executePath,
    { ...payload, authorizationSignature },
    serverUrl
  );
}

function replaceBigInts<T>(obj: T, replacer: (v: bigint) => unknown): T {
  if (typeof obj === "bigint") return replacer(obj) as T;
  if (Array.isArray(obj))
    return obj.map((x) => replaceBigInts(x, replacer)) as T;
  if (obj && typeof obj === "object")
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, replaceBigInts(v, replacer)])
    ) as T;
  return obj;
}

function createRemoteSigner(params: {
  address: Hex;
  walletId: string;
  signerPrivateKey: string | undefined;
  signFn: SignFn | undefined;
  serverUrl: string;
  privyAppId: string;
}): LocalAccount<"privy-remote"> {
  const { address, walletId, signerPrivateKey, signFn, serverUrl, privyAppId } =
    params;

  return {
    type: "local",
    source: "privy-remote",
    address,
    publicKey: "0x",

    signMessage: async ({ message }: { message: SignableMessage }) => {
      const encoded = encodeSignableMessage(message);
      const rpcBody = {
        method: "personal_sign" as const,
        chain_type: "ethereum" as const,
        params: { message: encoded.message, encoding: encoded.encoding },
      };
      const result = await signedServerCall<{ signature: Hex }>(
        "/wallets/sign-message",
        walletId,
        rpcBody,
        { walletAddress: address, walletId, ...encoded },
        signerPrivateKey,
        serverUrl,
        privyAppId,
        signFn
      );
      return result.signature;
    },

    signTypedData: async <
      const TTypedData extends
        | Record<string, unknown>
        | Record<string, unknown>,
      TPrimaryType extends keyof TTypedData | "EIP712Domain" = keyof TTypedData,
    >(
      typedDataDef: TypedDataDefinition<TTypedData, TPrimaryType>
    ) => {
      const { domain, types, primaryType, message } = replaceBigInts(
        typedDataDef as any,
        toHex
      );
      const typedData = {
        domain: domain ?? {},
        types: types ?? {},
        primary_type: primaryType,
        message: message ?? {},
      };
      const rpcBody = {
        method: "eth_signTypedData_v4" as const,
        chain_type: "ethereum" as const,
        params: { typed_data: typedData },
      };
      const result = await signedServerCall<{ signature: Hex }>(
        "/wallets/sign-typed-data",
        walletId,
        rpcBody,
        { walletAddress: address, walletId, typedData },
        signerPrivateKey,
        serverUrl,
        privyAppId,
        signFn
      );
      return result.signature;
    },

    signTransaction: async (transaction) => {
      const raw = replaceBigInts(transaction, toHex) as Record<string, unknown>;

      // Map viem tx fields to Privy's snake_case format
      const TX_TYPE_MAP: Record<string, number> = {
        legacy: 0, eip2930: 1, eip1559: 2, eip4844: 3, eip7702: 4,
      };
      const privyTx: Record<string, unknown> = {
        ...(raw.to != null ? { to: raw.to } : {}),
        ...(raw.from != null ? { from: raw.from } : {}),
        ...(raw.data != null ? { data: raw.data } : {}),
        ...(raw.value != null ? { value: raw.value } : {}),
        ...(raw.nonce != null ? { nonce: raw.nonce } : {}),
        ...(raw.gas != null ? { gas_limit: raw.gas } : {}),
        ...(raw.gasPrice != null ? { gas_price: raw.gasPrice } : {}),
        ...(raw.maxFeePerGas != null ? { max_fee_per_gas: raw.maxFeePerGas } : {}),
        ...(raw.maxPriorityFeePerGas != null ? { max_priority_fee_per_gas: raw.maxPriorityFeePerGas } : {}),
        ...(raw.chainId != null ? { chain_id: raw.chainId } : {}),
      };
      if (raw.type != null) {
        privyTx.type = typeof raw.type === "string"
          ? (TX_TYPE_MAP[raw.type] ?? Number(raw.type))
          : raw.type;
      }

      const rpcBody = {
        method: "eth_signTransaction" as const,
        chain_type: "ethereum" as const,
        params: { transaction: privyTx },
      };
      const result = await signedServerCall<{ signedTransaction: Hex }>(
        "/wallets/sign-transaction",
        walletId,
        rpcBody,
        { walletAddress: address, walletId, transaction: privyTx },
        signerPrivateKey,
        serverUrl,
        privyAppId,
        signFn
      );
      return result.signedTransaction;
    },

    signAuthorization: async (unsignedAuth) => {
      const contract =
        (unsignedAuth as any).contractAddress ?? (unsignedAuth as any).address;
      const chainId = unsignedAuth.chainId;
      const nonce = unsignedAuth.nonce;
      const rpcBody = {
        method: "eth_sign7702Authorization" as const,
        chain_type: "ethereum" as const,
        params: {
          contract,
          chain_id: chainId,
          ...(nonce != null ? { nonce } : {}),
        },
      };
      const result = await signedServerCall<{
        authorization: {
          address: Hex;
          nonce: number;
          chainId: number;
          yParity: number;
          r: Hex;
          s: Hex;
        };
      }>(
        "/wallets/sign-authorization",
        walletId,
        rpcBody,
        {
          walletAddress: address,
          walletId,
          contract,
          chainId,
          ...(nonce != null ? { nonce } : {}),
        },
        signerPrivateKey,
        serverUrl,
        privyAppId,
        signFn
      );
      return result.authorization;
    },
  };
}

type ChainClients = {
  smartWalletClient: SmartWalletClient;
  walletClient: WalletClient;
};

export function appendBuilderCodeData(data: Hex, suffix: Hex): Hex {
  const opDataByteLength = (data.length - 2) / 2;
  const suffixByteLength = (suffix.length - 2) / 2;
  const opDataPaddedSize = Math.ceil(opDataByteLength / 32) * 32;
  const suffixPaddedSize = Math.ceil(suffixByteLength / 32) * 32;

  const paddedData = pad(data, { size: opDataPaddedSize, dir: "right" });
  const paddedSuffix = pad(suffix, { size: suffixPaddedSize });

  return concatHex([paddedData, paddedSuffix]);
}

export class PrivyAlchemyEvmProviderAdapter implements IEvmProviderAdapter {
  public readonly providerName: string = "Privy Alchemy";
  public readonly address: Address;
  private readonly chainClients: Map<number, ChainClients>;
  private readonly signer: LocalAccount<"privy-remote">;
  private readonly builderCodeSuffix: Hex | undefined;

  private constructor(
    address: Address,
    chainClients: Map<number, ChainClients>,
    signer: LocalAccount<"privy-remote">,
    builderCode?: string
  ) {
    this.address = address;
    this.chainClients = chainClients;
    this.signer = signer;
    this.builderCodeSuffix = builderCode
      ? Attribution.toDataSuffix({ codes: [builderCode] })
      : undefined;
  }

  static async create(
    params: PrivyAlchemyChainConfig
  ): Promise<PrivyAlchemyEvmProviderAdapter> {
    if (!params.signerPrivateKey && !params.signFn) {
      throw new Error(
        "PrivyAlchemyEvmProviderAdapter: either signerPrivateKey or signFn must be provided"
      );
    }

    const chainClients = new Map<number, ChainClients>();

    const { chains = EVM_MAINNET_CHAINS } = params;
    const serverUrl = (params.serverUrl ?? ACP_SERVER_URL).replace(/\/$/, "");

    const signer = createRemoteSigner({
      address: params.walletAddress,
      walletId: params.walletId,
      signerPrivateKey: params.signerPrivateKey,
      signFn: params.signFn,
      serverUrl,
      privyAppId: params.privyAppId ?? PRIVY_APP_ID,
    });

    const authClient = new ProviderAuthClient({
      serverUrl,
      walletAddress: params.walletAddress,
      signMessage: (msg) => signer.signMessage({ message: msg }),
      chainId: chains[0]!.id,
    });

    const getToken = () => authClient.getAuthToken();

    const authedFetch: typeof fetch = async (input, init) => {
      const token = await getToken();
      return fetch(input, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          Authorization: `Bearer ${token}`,
        },
      });
    };

    for (const chain of chains) {
      const smartWalletClient = createSmartWalletClient({
        transport: alchemyWalletTransport({
          url: `${serverUrl}/wallets/alchemy-rpc`,
          fetchFn: authedFetch,
        }),
        chain,
        signer,
        account: params.walletAddress,
      });

      const walletClient = createWalletClient({
        account: signer,
        chain,
        transport: http(`${serverUrl}/wallets/alchemy-rpc/${chain.id}`, {
          fetchFn: authedFetch,
        }),
      });

      chainClients.set(chain.id, { smartWalletClient, walletClient });
    }

    return new PrivyAlchemyEvmProviderAdapter(
      params.walletAddress,
      chainClients,
      signer,
      params.builderCode
    );
  }

  private getClients(chainId: number): ChainClients {
    const c = this.chainClients.get(chainId);
    if (!c)
      throw new Error(
        `PrivyAlchemyEvmProviderAdapter: no clients configured for chainId ${chainId}`
      );
    return c;
  }

  async getAddress(): Promise<Address> {
    return this.address;
  }

  async getSupportedChainIds(): Promise<number[]> {
    return Array.from(this.chainClients.keys());
  }

  async getNetworkContext(chainId: number) {
    return createEvmNetworkContext(chainId);
  }

  private getRandomNonce(bits = 152): Hex {
    const bytes = bits / 8;
    const array = new Uint8Array(bytes);
    crypto.getRandomValues(array);

    const hex = Array.from(array, (b) => b.toString(16).padStart(2, "0")).join(
      ""
    );
    return `0x${hex}`;
  }

  async sendTransaction(chainId: number, call: Call): Promise<Address> {
    const { walletClient } = this.getClients(chainId);
    return walletClient.sendTransaction({
      account: walletClient.account!,
      chain: walletClient.chain,
      to: call.to,
      data: call.data,
      value: call.value,
    });
  }

  async sendCalls(
    chainId: number,
    _calls: Call[]
  ): Promise<Address | Address[]> {
    const { smartWalletClient } = this.getClients(chainId);
    const suffix = this.builderCodeSuffix;
    const { id } = await smartWalletClient.sendCalls({
      calls: _calls.map((call) => ({
        to: call.to,
        data: suffix
          ? appendBuilderCodeData(call.data ?? "0x", suffix)
          : call.data ?? "0x",
        value: call.value ?? 0n,
      })),
      capabilities: {
        nonceOverride: {
          nonceKey: this.getRandomNonce(),
        },
      },
    });

    const status = await smartWalletClient.waitForCallsStatus({ id });

    if (!status.receipts?.[0]?.transactionHash) {
      throw new Error("Transaction failed");
    }

    return status.receipts?.[0]?.transactionHash;
  }

  async getTransactionReceipt(
    chainId: number,
    hash: Address
  ): Promise<TransactionReceipt> {
    return getTransactionReceipt(this.getClients(chainId).walletClient, {
      hash,
    });
  }

  async readContract(
    chainId: number,
    params: ReadContractParams
  ): Promise<unknown> {
    return readContract(this.getClients(chainId).walletClient, params);
  }

  async getLogs(chainId: number, params: GetLogsParams): Promise<Log[]> {
    return getLogs(this.getClients(chainId).walletClient, params);
  }

  async getBlockNumber(chainId: number): Promise<bigint> {
    return getBlockNumber(this.getClients(chainId).walletClient);
  }

  async signMessage(chainId: number, _message: string): Promise<string> {
    return this.signer.signMessage({
      message: _message,
    });
  }

  async signTypedData(chainId: number, typedData: unknown): Promise<string> {
    return this.signer.signTypedData(typedData as any);
  }
}
