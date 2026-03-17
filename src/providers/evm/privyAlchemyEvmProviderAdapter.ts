import { baseSepolia } from "@account-kit/infra";
import {
  createPublicClient,
  LocalAccount,
  toHex,
  TypedDataDefinition,
  type Address,
  type Call,
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
import { createEvmNetworkContext } from "../../core/chains";
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
  alchemyWalletTransport,
  type SmartWalletClient,
} from "@alchemy/wallet-apis";

interface PrivyAlchemyEvmProviderAdapterParams {
  walletAddress: Address;
  walletId: string;
  signerPrivateKey: string;
}

const PRIVY_APP_ID = "cmcw5496d003jl20ng79cgb8l";
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

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
  body: Record<string, unknown>
): WalletApiRequestSignatureInput {
  return {
    version: 1,
    method: "POST",
    url: `https://api.privy.io/v1/wallets/${walletId}/rpc`,
    body,
    headers: { "privy-app-id": PRIVY_APP_ID },
  };
}

async function serverPost<T>(
  path: string,
  body: unknown,
  serverUrl: string = "http://localhost:3000"
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
  serverUrl?: string
): Promise<T> {
  const input = buildSignInput(walletId, rpcBody);
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
  serverUrl?: string;
}): LocalAccount<"privy-remote"> {
  const { address, walletId, signerPrivateKey, serverUrl } = params;

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
        { walletId, ...encoded },
        signerPrivateKey,
        serverUrl
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
        { walletId, typedData },
        signerPrivateKey,
        serverUrl
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
        { walletId, contract, chainId, ...(nonce != null ? { nonce } : {}) },
        signerPrivateKey,
        serverUrl
      );
      return result.authorization;
    },
  };
}

export class PrivyAlchemyEvmProviderAdapter implements IEvmProviderAdapter {
  public readonly providerName: string = "Privy Alchemy";
  public readonly address: Address;
  public readonly chainId: number;
  public readonly client: SmartWalletClient;

  constructor(address: Address, chainId: number, client: SmartWalletClient) {
    this.address = address;
    this.chainId = chainId;
    this.client = client;
  }

  static async create(
    params: PrivyAlchemyEvmProviderAdapterParams
  ): Promise<PrivyAlchemyEvmProviderAdapter> {
    const signer = await createRemoteSigner({
      address: params.walletAddress,
      walletId: params.walletId,
      signerPrivateKey: params.signerPrivateKey,
    });

    const client = createSmartWalletClient({
      transport: alchemyWalletTransport({
        url: `https://api.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
      }),
      chain: baseSepolia,
      signer,
      account: params.walletAddress,
      paymaster: { policyId: "186aaa4a-5f57-4156-83fb-e456365a8820" },
    });

    return new PrivyAlchemyEvmProviderAdapter(
      params.walletAddress,
      baseSepolia.id,
      client
    );
  }

  async getAddress(): Promise<Address> {
    return this.address;
  }

  async getChainId(): Promise<number> {
    return this.chainId;
  }

  async getNetworkContext() {
    const chainId = await this.getChainId();
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

  async sendCalls(_calls: Call[]): Promise<Address | Address[]> {
    const { id } = await this.client.sendCalls({
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

    const status = await this.client.waitForCallsStatus({ id });

    if (!status.receipts?.[0]?.transactionHash) {
      throw new Error("Transaction failed");
    }

    return status.receipts?.[0]?.transactionHash;
  }

  async getTransactionReceipt(hash: Address): Promise<TransactionReceipt> {
    return getTransactionReceipt(
      createPublicClient({
        chain: baseSepolia,
        transport: alchemyWalletTransport({
          url: `https://alchemy-proxy.virtuals.io/api/proxy/rpc?chainId=${this.chainId}`,
        }),
      }),
      { hash }
    );
  }

  async readContract(params: ReadContractParams): Promise<unknown> {
    return readContract(this.client, params);
  }

  async getLogs(params: GetLogsParams): Promise<Log[]> {
    return getLogs(this.client, params);
  }

  async getBlockNumber(): Promise<bigint> {
    return getBlockNumber(this.client);
  }

  async signMessage(_message: string): Promise<string> {
    throw new Error("signMessage() not implemented");
  }
}
