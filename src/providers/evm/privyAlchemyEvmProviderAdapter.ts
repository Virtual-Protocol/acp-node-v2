import {
  BaseError,
  concatHex,
  createWalletClient,
  http,
  type LocalAccount,
  numberToHex,
  pad,
  serializeSignature,
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
import {
  createEvmNetworkContext,
  EVM_MAINNET_CHAINS,
  ERC20_SPONSORED_CHAINS,
} from "../../core/chains.js";
import type {
  GetLogsParams,
  IEvmProviderAdapter,
  ReadContractParams,
} from "../types.js";
import type { RemoteSigner, SignUserOperationParams } from "./types.js";
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
import {
  ACP_SERVER_URL,
  ALCHEMY_SIGNING_CONTRACT,
  PRIVY_APP_ID,
} from "../../core/constants.js";
import { ProviderAuthClient } from "../providerAuthClient.js";
import {
  ApprovalRequiredError,
  awaitApproval,
} from "../../core/approvalGate.js";

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
    const payload = data?.code ? data : data?.message;
    if (res.status === 403 && payload?.code === "APPROVAL_REQUIRED") {
      const approvalId = payload.details?.approvalId ?? "";
      const approvalUrl = payload.details?.approvalUrl ?? "";
      const detail = payload.detail ?? "Manual approval required";
      console.error(
        `[PrivyAlchemy] Manual approval required.\n` +
          `  Approve at: ${approvalUrl}\n` +
          `  Approval ID: ${approvalId}\n` +
          `  Reason: ${detail}`
      );
      throw new ApprovalRequiredError(approvalId, approvalUrl, detail);
    }

    const msg =
      data?.detail ??
      data?.error ??
      data?.shortMessage ??
      `Server error ${res.status}`;

    throw new BaseError(msg, {
      details: data?.details,
    });
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

  try {
    return await serverPost<T>(
      executePath,
      { ...payload, authorizationSignature },
      serverUrl
    );
  } catch (err) {
    if (err instanceof ApprovalRequiredError) {
      const result = await awaitApproval<T>(err.approvalId);
      if (result === undefined) {
        throw new Error(
          `Approval ${err.approvalId} resolved as approved but no result payload was provided`
        );
      }
      return result;
    }
    throw err;
  }
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
}): RemoteSigner {
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
        privyAppId,
        signFn
      );
      return result.signature;
    },

    signTransaction: async (transaction) => {
      const raw = replaceBigInts(transaction, toHex) as Record<string, unknown>;

      // Map viem tx fields to Privy's snake_case format
      const TX_TYPE_MAP: Record<string, number> = {
        legacy: 0,
        eip2930: 1,
        eip1559: 2,
        eip4844: 3,
        eip7702: 4,
      };
      const privyTx: Record<string, unknown> = {
        ...(raw.to != null ? { to: raw.to } : {}),
        ...(raw.from != null ? { from: raw.from } : {}),
        ...(raw.data != null ? { data: raw.data } : {}),
        ...(raw.value != null ? { value: raw.value } : {}),
        ...(raw.nonce != null ? { nonce: raw.nonce } : {}),
        ...(raw.gas != null ? { gas_limit: raw.gas } : {}),
        ...(raw.gasPrice != null ? { gas_price: raw.gasPrice } : {}),
        ...(raw.maxFeePerGas != null
          ? { max_fee_per_gas: raw.maxFeePerGas }
          : {}),
        ...(raw.maxPriorityFeePerGas != null
          ? { max_priority_fee_per_gas: raw.maxPriorityFeePerGas }
          : {}),
        ...(raw.chainId != null ? { chain_id: raw.chainId } : {}),
      };
      if (raw.type != null) {
        privyTx.type =
          typeof raw.type === "string"
            ? TX_TYPE_MAP[raw.type] ?? Number(raw.type)
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

    signUserOperation: async ({
      chainId,
      contract,
      userOperation,
    }: SignUserOperationParams) => {
      const rpcBody = {
        method: "eth_signUserOperation" as const,
        chain_type: "ethereum" as const,
        params: {
          chain_id: chainId,
          contract,
          user_operation: {
            sender: userOperation.sender,
            nonce: numberToHex(userOperation.nonce),
            call_data: userOperation.callData,
            call_gas_limit: numberToHex(userOperation.callGasLimit),
            verification_gas_limit: numberToHex(
              userOperation.verificationGasLimit
            ),
            pre_verification_gas: numberToHex(userOperation.preVerificationGas),
            max_fee_per_gas: numberToHex(userOperation.maxFeePerGas),
            max_priority_fee_per_gas: numberToHex(
              userOperation.maxPriorityFeePerGas
            ),
            paymaster: userOperation.paymaster,
            paymaster_data: userOperation.paymasterData,
            paymaster_verification_gas_limit:
              userOperation.paymasterVerificationGasLimit != null
                ? numberToHex(userOperation.paymasterVerificationGasLimit)
                : undefined,
            paymaster_post_op_gas_limit:
              userOperation.paymasterPostOpGasLimit != null
                ? numberToHex(userOperation.paymasterPostOpGasLimit)
                : undefined,
          },
        },
      };
      const result = await signedServerCall<{
        signature: Hex;
        encoding: "hex";
      }>(
        "/wallets/sign-user-operation",
        walletId,
        rpcBody,
        {
          walletAddress: address,
          walletId,
          chainId,
          contract,
          userOperation: replaceBigInts(userOperation, toHex),
        },
        signerPrivateKey,
        serverUrl,
        privyAppId,
        signFn
      );
      return result.signature;
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

export function appendBuilderCodeData(data: Hex, suffix: Hex): Hex {
  const opDataByteLength = (data.length - 2) / 2;
  const suffixByteLength = (suffix.length - 2) / 2;
  const opDataPaddedSize = Math.ceil(opDataByteLength / 32) * 32;
  const suffixPaddedSize = Math.ceil(suffixByteLength / 32) * 32;

  const paddedData = pad(data, { size: opDataPaddedSize, dir: "right" });
  const paddedSuffix = pad(suffix, { size: suffixPaddedSize });

  return concatHex([paddedData, paddedSuffix]);
}

type SignConfig = {
  walletId: string;
  signerPrivateKey: string | undefined;
  signFn: SignFn | undefined;
  serverUrl: string;
  privyAppId: string;
};

type PrivyUserOperation = {
  sender: Address;
  nonce: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymaster: Hex;
  paymasterData: Hex;
  paymasterVerificationGasLimit: Hex;
  paymasterPostOpGasLimit: Hex;
};

function toPrivyUserOperation(u: PrivyUserOperation) {
  return {
    sender: u.sender,
    nonce: u.nonce,
    call_data: u.callData,
    call_gas_limit: u.callGasLimit,
    verification_gas_limit: u.verificationGasLimit,
    pre_verification_gas: u.preVerificationGas,
    max_fee_per_gas: u.maxFeePerGas,
    max_priority_fee_per_gas: u.maxPriorityFeePerGas,
    paymaster: u.paymaster,
    paymaster_data: u.paymasterData,
    paymaster_verification_gas_limit: u.paymasterVerificationGasLimit,
    paymaster_post_op_gas_limit: u.paymasterPostOpGasLimit,
  };
}

export class PrivyAlchemyEvmProviderAdapter implements IEvmProviderAdapter {
  public readonly providerName: string = "Privy Alchemy";
  public readonly address: Address;
  // Gasless ACP client — driven by the per-instance `chains` config.
  private readonly acpClients: Map<number, SmartWalletClient>;
  // ERC20-sponsored client — fixed supported set (ERC20_SPONSORED_CHAINS).
  private readonly erc20Clients: Map<number, SmartWalletClient>;
  // Read/EOA client — built for every chain either smart client can touch.
  private readonly walletClients: Map<number, WalletClient>;
  private readonly signer: RemoteSigner;
  private readonly builderCodeSuffix: Hex | undefined;
  private readonly signConfig: SignConfig;

  private constructor(
    address: Address,
    acpClients: Map<number, SmartWalletClient>,
    erc20Clients: Map<number, SmartWalletClient>,
    walletClients: Map<number, WalletClient>,
    signer: RemoteSigner,
    signConfig: SignConfig,
    builderCode?: string
  ) {
    this.address = address;
    this.acpClients = acpClients;
    this.erc20Clients = erc20Clients;
    this.walletClients = walletClients;
    this.signer = signer;
    this.signConfig = signConfig;
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
      signMessage: (message) => signer.signMessage({ message }),
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

    const makeSmartClient = (chain: Chain, url: string) =>
      createSmartWalletClient({
        transport: alchemyWalletTransport({ url, fetchFn: authedFetch }),
        chain,
        signer,
        account: params.walletAddress,
      });

    // Gasless ACP client — only the chains the caller configured.
    const acpClients = new Map<number, SmartWalletClient>();
    for (const chain of chains) {
      acpClients.set(
        chain.id,
        makeSmartClient(chain, `${serverUrl}/wallets/alchemy-rpc`)
      );
    }

    // ERC20-sponsored client — fixed supported set, independent of `chains`.
    const erc20Clients = new Map<number, SmartWalletClient>();
    for (const chain of ERC20_SPONSORED_CHAINS) {
      erc20Clients.set(
        chain.id,
        makeSmartClient(chain, `${serverUrl}/wallets/alchemy-rpc-erc20`)
      );
    }

    // Read/EOA client — every chain either smart client can operate on.
    const walletClients = new Map<number, WalletClient>();
    for (const chain of [...chains, ...ERC20_SPONSORED_CHAINS]) {
      if (walletClients.has(chain.id)) continue;
      walletClients.set(
        chain.id,
        createWalletClient({
          account: signer as LocalAccount<"privy-remote">,
          chain,
          transport: http(`${serverUrl}/wallets/alchemy-rpc/${chain.id}`, {
            fetchFn: authedFetch,
          }),
        })
      );
    }

    return new PrivyAlchemyEvmProviderAdapter(
      params.walletAddress,
      acpClients,
      erc20Clients,
      walletClients,
      signer,
      {
        walletId: params.walletId,
        signerPrivateKey: params.signerPrivateKey,
        signFn: params.signFn,
        serverUrl,
        privyAppId: params.privyAppId ?? PRIVY_APP_ID,
      },
      params.builderCode
    );
  }

  private getClientOrThrow<T>(
    map: Map<number, T>,
    chainId: number,
    label: string
  ): T {
    const c = map.get(chainId);
    if (!c)
      throw new Error(
        `PrivyAlchemyEvmProviderAdapter: ${label} for chainId ${chainId}`
      );
    return c;
  }

  private getAcpClient(chainId: number): SmartWalletClient {
    return this.getClientOrThrow(
      this.acpClients,
      chainId,
      "ACP not configured"
    );
  }

  private getErc20Client(chainId: number): SmartWalletClient {
    return this.getClientOrThrow(
      this.erc20Clients,
      chainId,
      "ERC20-sponsored sendTransaction not supported"
    );
  }

  private getWalletClient(chainId: number): WalletClient {
    return this.getClientOrThrow(
      this.walletClients,
      chainId,
      "No client configured"
    );
  }

  async getAddress(): Promise<Address> {
    return this.address;
  }

  async getSupportedChainIds(): Promise<number[]> {
    // ACP-supported chains (the gasless smartWalletClient set).
    return Array.from(this.acpClients.keys());
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

  // Sign a prepared (v0.7) userOp through the backend's Privy eth_signUserOperation.
  // Privy decodes the userOp and enforces wallet policy here (vs personal_sign, which
  // only signs an opaque hash). The authorization signature must be computed over the
  // exact body the backend forwards to Privy, so the snake_case `user_operation` below
  private async signUserOperation(
    chainId: number,
    contract: Address,
    userOp: any
  ): Promise<Hex> {
    const userOperation: PrivyUserOperation = {
      sender: userOp.sender as Address,
      nonce: numberToHex(userOp.nonce),
      callData: userOp.callData as Hex,
      callGasLimit: numberToHex(userOp.callGasLimit),
      verificationGasLimit: numberToHex(userOp.verificationGasLimit),
      preVerificationGas: numberToHex(userOp.preVerificationGas),
      maxFeePerGas: numberToHex(userOp.maxFeePerGas),
      maxPriorityFeePerGas: numberToHex(userOp.maxPriorityFeePerGas),
      paymaster: (userOp.paymaster ?? "0x") as Hex,
      paymasterData: (userOp.paymasterData ?? "0x") as Hex,
      paymasterVerificationGasLimit:
        userOp.paymasterVerificationGasLimit != null
          ? numberToHex(userOp.paymasterVerificationGasLimit)
          : "0x0",
      paymasterPostOpGasLimit:
        userOp.paymasterPostOpGasLimit != null
          ? numberToHex(userOp.paymasterPostOpGasLimit)
          : "0x0",
    };

    const rpcBody = {
      method: "eth_signUserOperation" as const,
      chain_type: "ethereum" as const,
      params: {
        chain_id: chainId,
        contract,
        user_operation: toPrivyUserOperation(userOperation),
      },
    };

    const result = await signedServerCall<{ signature: Hex }>(
      "/wallets/sign-user-operation",
      this.signConfig.walletId,
      rpcBody,
      {
        walletAddress: this.address,
        walletId: this.signConfig.walletId,
        chainId,
        contract,
        userOperation,
      },
      this.signConfig.signerPrivateKey,
      this.signConfig.serverUrl,
      this.signConfig.privyAppId,
      this.signConfig.signFn
    );

    const sig = result.signature;
    return (sig.startsWith("0x") ? sig : `0x${sig}`) as Hex;
  }

  // Handles both a single v070 userOp and the `array` result
  // returned when the account still needs an EIP-7702 authorization (first tx of an
  // undelegated account): the authorization is signed via Privy eth_sign7702Authorization,
  // the userOp via eth_signUserOperation.
  private async signPreparedViaPrivy(
    chainId: number,
    prepared: any
  ): Promise<any> {
    const contract = ALCHEMY_SIGNING_CONTRACT as Address;

    const signUserOpEntry = async (entry: any) => {
      const { signatureRequest: _sr, feePayment: _fp, ...rest } = entry;
      const signature = await this.signUserOperation(
        chainId,
        contract,
        entry.data
      );
      return { ...rest, signature: { type: "secp256k1", data: signature } };
    };

    const signAuthEntry = async (entry: any) => {
      const { signatureRequest: _sr, ...rest } = entry;
      const auth: any = await (this.signer.signAuthorization as any)({
        ...entry.data,
        chainId: entry.chainId,
      });
      return {
        ...rest,
        signature: {
          type: "secp256k1",
          data: serializeSignature({
            r: auth.r,
            s: auth.s,
            yParity: Number(auth.yParity),
          }),
        },
      };
    };

    if (prepared.type === "user-operation-v070") {
      return signUserOpEntry(prepared);
    }
    if (prepared.type === "array") {
      const data = await Promise.all(
        prepared.data.map((entry: any) =>
          entry.type === "authorization"
            ? signAuthEntry(entry)
            : signUserOpEntry(entry)
        )
      );
      return { type: "array", data };
    }
    throw new Error(`Unexpected prepareCalls result type: ${prepared.type}`);
  }

  // Map an ACP call to the smart-wallet call shape, applying the builder-code suffix.
  private toSponsoredCall(call: Call) {
    const value = call.value ?? 0n;
    return {
      to: call.to,
      data: this.builderCodeSuffix
        ? appendBuilderCodeData(call.data ?? "0x", this.builderCodeSuffix)
        : call.data ?? "0x",
      ...(value !== 0n ? { value } : {}),
    };
  }

  private async waitForTransactionHash(
    client: SmartWalletClient,
    id: Hex
  ): Promise<Address> {
    const status = await client.waitForCallsStatus({ id });
    if (!status.receipts?.[0]?.transactionHash) {
      throw new Error("Transaction failed");
    }
    return status.receipts[0].transactionHash;
  }

  // Execute one or more calls as a single ERC20-sponsored userOp (the user pays
  // gas in USDC). prepareCalls accepts an array, so this serves BOTH a non-batch
  // send (one call) and an atomic EIP-5792 batch (many calls) through the same
  // path. The gasless smart-wallet client's wallet_prepareCalls 400s on chains
  // like Base mainnet, so we never use it; a chain without an ERC20-sponsored
  // client throws (no silent gasless fallback).
  private async submitSponsoredCalls(
    chainId: number,
    calls: Call[]
  ): Promise<Address> {
    const client = this.getErc20Client(chainId);
    const prepared = await client.prepareCalls({
      calls: calls.map((call) => this.toSponsoredCall(call)),
    });
    const signed = await this.signPreparedViaPrivy(chainId, prepared);
    const { id } = await client.sendPreparedCalls(signed);
    return this.waitForTransactionHash(client, id);
  }

  async sendTransaction(chainId: number, call: Call): Promise<Address> {
    // Non-batch: a single ERC20-sponsored call.
    return this.submitSponsoredCalls(chainId, [call]);
  }

  async sendCalls(
    chainId: number,
    _calls: Call[]
  ): Promise<Address | Address[]> {
    // Batch: an atomic EIP-5792 bundle through the same ERC20-sponsored path a
    // single send uses (prepareCalls accepts the array → one atomic userOp).
    return this.submitSponsoredCalls(chainId, _calls);
  }

  async getTransactionReceipt(
    chainId: number,
    hash: Address
  ): Promise<TransactionReceipt> {
    return getTransactionReceipt(this.getWalletClient(chainId), {
      hash,
    });
  }

  async readContract(
    chainId: number,
    params: ReadContractParams
  ): Promise<unknown> {
    return readContract(this.getWalletClient(chainId), params);
  }

  async getLogs(chainId: number, params: GetLogsParams): Promise<Log[]> {
    return getLogs(this.getWalletClient(chainId), params);
  }

  async getBlockNumber(chainId: number): Promise<bigint> {
    return getBlockNumber(this.getWalletClient(chainId));
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
