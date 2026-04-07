import {
  createPublicClient,
  http,
  LocalAccount,
  PublicClient,
  toHex,
  TypedDataDefinition,
  type Address,
  type Call,
  type Chain,
  type Hex,
  type Log,
  type SignableMessage,
  type TransactionReceipt,
} from "viem";
import {
  getTransactionReceipt,
  readContract,
  getLogs,
  getBlockNumber,
} from "viem/actions";
import { createEvmNetworkContext, EVM_CHAINS } from "../../core/chains";
import type {
  GetLogsParams,
  IEvmProviderAdapter,
  ReadContractParams,
} from "../types";
import {
  generateAuthorizationSignature,
  WalletApiRequestSignatureInput,
} from "@privy-io/node";
import {
  createSmartWalletClient,
  type SmartWalletClient,
  alchemyWalletTransport,
} from "@alchemy/wallet-apis";
import {
  ACP_SERVER_URL,
  ALCHEMY_POLICY_ID,
  PRIVY_APP_ID,
} from "../../core/constants";
import { ProviderAuthClient } from "../providerAuthClient";

export interface PrivyAlchemyChainConfig {
  chains?: Chain[];
  walletAddress: Address;
  walletId: string;
  signerPrivateKey: string;
  serverUrl?: string;
  privyAppId?: string;
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

function signedServerCall<T>(
  executePath: string,
  walletId: string,
  rpcBody: Record<string, unknown>,
  payload: Record<string, unknown>,
  signerPrivateKey: string,
  serverUrl: string,
  privyAppId: string = PRIVY_APP_ID
): Promise<T> {
  const input = buildSignInput(walletId, rpcBody, privyAppId);
  const authorizationSignature = generateAuthorizationSignature({
    authorizationPrivateKey: signerPrivateKey,
    input,
  });
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
  signerPrivateKey: string;
  serverUrl: string;
  privyAppId: string;
}): LocalAccount<"privy-remote"> {
  const { address, walletId, signerPrivateKey, serverUrl, privyAppId } = params;

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
        privyAppId
      );
      return result.signature;
    },

    signTypedData: async <
      const TTypedData extends
        | Record<string, unknown>
        | Record<string, unknown>,
      TPrimaryType extends keyof TTypedData | "EIP712Domain" = keyof TTypedData
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
        privyAppId
      );
      return result.signature;
    },

    signTransaction: async () => {
      throw new Error("signTransaction not supported — use sendCalls instead");
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
        privyAppId
      );
      return result.authorization;
    },
  };
}

type ChainClients = {
  smartWalletClient: SmartWalletClient;
  publicClient: PublicClient;
};

export class PrivyAlchemyEvmProviderAdapter implements IEvmProviderAdapter {
  public readonly providerName: string = "Privy Alchemy";
  public readonly address: Address;
  private readonly chainClients: Map<number, ChainClients>;

  private constructor(
    address: Address,
    chainClients: Map<number, ChainClients>
  ) {
    this.address = address;
    this.chainClients = chainClients;
  }

  static async create(
    params: PrivyAlchemyChainConfig
  ): Promise<PrivyAlchemyEvmProviderAdapter> {
    const chainClients = new Map<number, ChainClients>();

    const { chains = EVM_CHAINS } = params;
    const serverUrl = (params.serverUrl ?? ACP_SERVER_URL).replace(/\/$/, "");

    const signer = createRemoteSigner({
      address: params.walletAddress,
      walletId: params.walletId,
      signerPrivateKey: params.signerPrivateKey,
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

    for (const chain of chains) {
      const smartWalletClient = createSmartWalletClient({
        transport: alchemyWalletTransport({
          url: `${serverUrl}/wallets/alchemy-rpc`,
          fetchOptions: {
            headers: {
              Authorization: `Bearer ${await getToken()}`,
            },
          },
        }),
        chain,
        signer,
        account: params.walletAddress,
        paymaster: { policyId: ALCHEMY_POLICY_ID },
      });

      const publicClient = createPublicClient({
        chain,
        transport: http(`${serverUrl}/wallets/alchemy-rpc/${chain.id}`, {
          fetchOptions: {
            headers: {
              Authorization: `Bearer ${await getToken()}`,
            },
          },
        }),
      });

      chainClients.set(chain.id, { smartWalletClient, publicClient });
    }

    return new PrivyAlchemyEvmProviderAdapter(
      params.walletAddress,
      chainClients
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

  async sendCalls(
    chainId: number,
    _calls: Call[]
  ): Promise<Address | Address[]> {
    const { smartWalletClient } = this.getClients(chainId);
    const { id } = await smartWalletClient.sendCalls({
      calls: _calls.map((call) => ({
        to: call.to,
        data: call.data ?? "0x",
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
    return getTransactionReceipt(this.getClients(chainId).publicClient, {
      hash,
    });
  }

  async readContract(
    chainId: number,
    params: ReadContractParams
  ): Promise<unknown> {
    return readContract(this.getClients(chainId).publicClient, params);
  }

  async getLogs(chainId: number, params: GetLogsParams): Promise<Log[]> {
    return getLogs(this.getClients(chainId).publicClient, params);
  }

  async getBlockNumber(chainId: number): Promise<bigint> {
    return getBlockNumber(this.getClients(chainId).publicClient);
  }

  async signMessage(chainId: number, _message: string): Promise<string> {
    return this.getClients(chainId).smartWalletClient.signMessage({
      message: _message,
    });
  }

  async signTypedData(chainId: number, typedData: unknown): Promise<string> {
    return this.getClients(chainId).smartWalletClient.signTypedData(
      typedData as any
    );
  }
}
