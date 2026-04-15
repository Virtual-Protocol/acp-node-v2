import {
  createSolanaRpc,
  createSolanaRpcFromTransport,
  createSignableMessage,
  getBase58Decoder,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionEncoder,
  addSignersToTransactionMessage,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  type Address,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import type { SolanaCluster } from "../../core/chains";
import type { SolanaInstructionLike, SolanaSigner } from "../types";
import { SolanaProviderAdapter } from "./solanaProviderAdapter";
import {
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
  type WalletApiRequestSignatureInput,
} from "@privy-io/node";
import {
  ACP_SERVER_URL,
  ALCHEMY_POLICY_ID,
  PRIVY_APP_ID,
} from "../../core/constants";
import { ProviderAuthClient } from "../providerAuthClient";

// Alchemy placeholder fee payer for sponsored transactions.
// Replaced by the real fee payer after alchemy_requestFeePayer.
const ALCHEMY_PLACEHOLDER_PAYER =
  "Amh6quo1FcmL16Qmzdugzjq3Lv1zXzTW7ktswyLDzits" as Address;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type SignFn = (payload: Uint8Array) => Promise<string>;

export interface PrivySolanaConfig {
  walletAddress: string;
  walletId: string;
  signerPrivateKey?: string;
  signFn?: SignFn;
  cluster?: SolanaCluster;
  /** Explicit RPC URL. When set, bypasses the ACP server proxy. */
  rpcUrl?: string;
  serverUrl?: string;
  privyAppId?: string;
  /** Alchemy gas policy ID. When set, transactions are gas-sponsored. */
  gasPolicyId?: string;
}

// ---------------------------------------------------------------------------
// Privy auth helpers (same pattern as PrivyAlchemyEvmProviderAdapter)
// ---------------------------------------------------------------------------

function buildSignInput(
  walletId: string,
  body: Record<string, unknown>,
  privyAppId: string,
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
  serverUrl: string,
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
      (data as any)?.detail ??
        (data as any)?.error ??
        `Server error ${res.status}`,
    );
  }
  return data as T;
}

function generatePrivyAuthSig(
  walletId: string,
  rpcBody: Record<string, unknown>,
  signerPrivateKey: string | undefined,
  privyAppId: string,
  signFn?: SignFn,
): string | Promise<string> {
  const input = buildSignInput(walletId, rpcBody, privyAppId);
  if (signFn) {
    const formatted = formatRequestForAuthorizationSignature(input);
    return signFn(formatted);
  }
  if (signerPrivateKey) {
    return generateAuthorizationSignature({
      authorizationPrivateKey: signerPrivateKey,
      input,
    });
  }
  throw new Error(
    "PrivySolanaProviderAdapter: either signerPrivateKey or signFn must be provided",
  );
}

async function signedServerCall<T>(
  executePath: string,
  walletId: string,
  rpcBody: Record<string, unknown>,
  payload: Record<string, unknown>,
  signerPrivateKey: string | undefined,
  serverUrl: string,
  privyAppId: string,
  signFn?: SignFn,
): Promise<T> {
  const authorizationSignature = await generatePrivyAuthSig(
    walletId,
    rpcBody,
    signerPrivateKey,
    privyAppId,
    signFn,
  );
  return serverPost<T>(
    executePath,
    { ...payload, authorizationSignature },
    serverUrl,
  );
}

// ---------------------------------------------------------------------------
// Wire format helpers
// ---------------------------------------------------------------------------

function buildUnsignedWireBytes(
  messageBytes: Uint8Array,
  signatures: Record<string, Uint8Array | null>,
): Uint8Array {
  const sigEntries = Object.entries(signatures);
  const numSigs = sigEntries.length;
  const wire = new Uint8Array(1 + numSigs * 64 + messageBytes.length);
  wire[0] = numSigs;
  for (let i = 0; i < numSigs; i++) {
    const sig = sigEntries[i]![1];
    if (sig) wire.set(sig, 1 + i * 64);
  }
  wire.set(messageBytes, 1 + numSigs * 64);
  return wire;
}

// ---------------------------------------------------------------------------
// Remote Solana signer (delegates to Privy via ACP server)
// ---------------------------------------------------------------------------

function createPrivySolanaSigner(params: {
  address: Address;
  walletId: string;
  signerPrivateKey?: string;
  signFn?: SignFn;
  serverUrl: string;
  privyAppId: string;
}): SolanaSigner {
  const {
    address,
    walletId,
    signerPrivateKey,
    signFn,
    serverUrl,
    privyAppId,
  } = params;

  return {
    address,

    async signTransactions(transactions: readonly any[]): Promise<any> {
      return Promise.all(
        transactions.map(async (tx: any) => {
          const wireBytes = buildUnsignedWireBytes(
            new Uint8Array(tx.messageBytes),
            tx.signatures as Record<string, Uint8Array | null>,
          );
          const unsignedBase64 = Buffer.from(wireBytes).toString("base64");

          const rpcBody = {
            method: "solana:signTransaction" as const,
            chain_type: "solana" as const,
            params: { transaction: unsignedBase64 },
          };

          const result = await signedServerCall<{
            signedTransaction: string;
          }>(
            "/wallets/solana/sign-transaction",
            walletId,
            rpcBody,
            {
              walletAddress: address,
              walletId,
              transaction: unsignedBase64,
            },
            signerPrivateKey,
            serverUrl,
            privyAppId,
            signFn,
          );

          const signedWire = new Uint8Array(
            Buffer.from(result.signedTransaction, "base64"),
          );
          const sigAddresses = Object.keys(tx.signatures);
          const ourIndex = sigAddresses.indexOf(address as string);
          if (ourIndex < 0) {
            throw new Error(
              "Signer address not found in transaction signatures",
            );
          }
          const sigBytes = signedWire.subarray(
            1 + ourIndex * 64,
            1 + (ourIndex + 1) * 64,
          );

          return Object.freeze({ [address]: sigBytes });
        }),
      );
    },

    async signMessages(messages: readonly any[]): Promise<any> {
      return Promise.all(
        messages.map(async (msg: any) => {
          const contentBase64 = Buffer.from(msg.content).toString("base64");

          const rpcBody = {
            method: "solana:signMessage" as const,
            chain_type: "solana" as const,
            params: { message: contentBase64 },
          };

          const result = await signedServerCall<{ signature: string }>(
            "/wallets/solana/sign-message",
            walletId,
            rpcBody,
            {
              walletAddress: address,
              walletId,
              message: contentBase64,
            },
            signerPrivateKey,
            serverUrl,
            privyAppId,
            signFn,
          );

          const sigBytes = new Uint8Array(
            Buffer.from(result.signature, "base64"),
          );
          return Object.freeze({ [address]: sigBytes });
        }),
      );
    },
  } as SolanaSigner;
}

// ---------------------------------------------------------------------------
// PrivySolanaProviderAdapter
// ---------------------------------------------------------------------------

export class PrivySolanaProviderAdapter extends SolanaProviderAdapter {
  private readonly _address: string;
  private readonly _rpc: Rpc<SolanaRpcApi>;
  private readonly _cluster: SolanaCluster;
  private readonly _signer: SolanaSigner;

  // Privy signing params (stored for direct signTransaction calls)
  private readonly _walletId: string;
  private readonly _signerPrivateKey: string | undefined;
  private readonly _signFn: SignFn | undefined;
  private readonly _serverUrl: string;
  private readonly _privyAppId: string;

  // Gas sponsorship
  private readonly _rpcProxyUrl: string | null;
  private readonly _gasPolicyId: string | null;
  private _getAuthToken: (() => Promise<string>) | null = null;

  private constructor(params: {
    address: string;
    rpc: Rpc<SolanaRpcApi>;
    cluster: SolanaCluster;
    signer: SolanaSigner;
    walletId: string;
    signerPrivateKey?: string;
    signFn?: SignFn;
    serverUrl: string;
    privyAppId: string;
    rpcProxyUrl: string | null;
    gasPolicyId: string | null;
  }) {
    super("privy-solana");
    this._address = params.address;
    this._rpc = params.rpc;
    this._cluster = params.cluster;
    this._signer = params.signer;
    this._walletId = params.walletId;
    this._signerPrivateKey = params.signerPrivateKey;
    this._signFn = params.signFn;
    this._serverUrl = params.serverUrl;
    this._privyAppId = params.privyAppId;
    this._rpcProxyUrl = params.rpcProxyUrl;
    this._gasPolicyId = params.gasPolicyId;
  }

  static async create(
    params: PrivySolanaConfig,
  ): Promise<PrivySolanaProviderAdapter> {
    if (!params.signerPrivateKey && !params.signFn) {
      throw new Error(
        "PrivySolanaProviderAdapter: either signerPrivateKey or signFn must be provided",
      );
    }

    const serverUrl = (params.serverUrl ?? ACP_SERVER_URL).replace(/\/$/, "");
    const privyAppId = params.privyAppId ?? PRIVY_APP_ID;
    const cluster = params.cluster ?? "devnet";
    const address = params.walletAddress as Address;
    const gasPolicyId = params.gasPolicyId ?? ALCHEMY_POLICY_ID;

    const signer = createPrivySolanaSigner({
      address,
      walletId: params.walletId,
      ...(params.signerPrivateKey
        ? { signerPrivateKey: params.signerPrivateKey }
        : {}),
      ...(params.signFn ? { signFn: params.signFn } : {}),
      serverUrl,
      privyAppId,
    });

    let rpc: Rpc<SolanaRpcApi>;
    let rpcProxyUrl: string | null = null;
    let getToken: (() => Promise<string>) | null = null;

    if (params.rpcUrl) {
      rpc = createSolanaRpc(params.rpcUrl) as Rpc<SolanaRpcApi>;
    } else {
      rpcProxyUrl = `${serverUrl}/wallets/alchemy-rpc/solana`;

      const authClient = new ProviderAuthClient({
        serverUrl,
        walletAddress: params.walletAddress,
        signMessage: async (msg: string) => {
          const signable = createSignableMessage(msg);
          const [sigs] = await signer.signMessages([signable]);
          const sigBytes = sigs![address];
          if (!sigBytes) throw new Error("Solana message signing failed");
          return getBase58Decoder().decode(sigBytes);
        },
        chainId: 0,
      });

      getToken = () => authClient.getAuthToken();

      const proxyUrl = rpcProxyUrl;
      const transport = async (config: { payload: unknown }): Promise<any> => {
        const token = await getToken!();
        const res = await fetch(proxyUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(config.payload),
        });
        return await res.json();
      };

      rpc = createSolanaRpcFromTransport(transport as any) as Rpc<SolanaRpcApi>;
    }

    const adapter = new PrivySolanaProviderAdapter({
      address: params.walletAddress,
      rpc,
      cluster,
      signer,
      walletId: params.walletId,
      ...(params.signerPrivateKey
        ? { signerPrivateKey: params.signerPrivateKey }
        : {}),
      ...(params.signFn ? { signFn: params.signFn } : {}),
      serverUrl,
      privyAppId,
      rpcProxyUrl,
      gasPolicyId,
    });
    adapter._getAuthToken = getToken;
    return adapter;
  }

  override async getAddress(): Promise<string> {
    return this._address;
  }

  override async getCluster(): Promise<SolanaCluster> {
    return this._cluster;
  }

  override getRpc(): Rpc<SolanaRpcApi> {
    return this._rpc;
  }

  override getSigner(): SolanaSigner {
    return this._signer;
  }

  // -------------------------------------------------------------------------
  // Gas sponsorship: alchemy_requestFeePayer
  // -------------------------------------------------------------------------

  private async requestFeePayer(
    serializedTransaction: string,
  ): Promise<string> {
    if (!this._rpcProxyUrl || !this._getAuthToken || !this._gasPolicyId) {
      throw new Error(
        "Gas sponsorship requires a proxied RPC and a gasPolicyId",
      );
    }

    const token = await this._getAuthToken();
    const res = await fetch(this._rpcProxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_requestFeePayer",
        params: [
          {
            policyId: this._gasPolicyId,
            serializedTransaction,
          },
        ],
      }),
    });

    const json = (await res.json()) as any;
    if (json.error) {
      throw new Error(
        `alchemy_requestFeePayer failed: ${json.error.message ?? JSON.stringify(json.error)}`,
      );
    }
    return json.result.serializedTransaction;
  }

  // -------------------------------------------------------------------------
  // Direct Privy transaction signing (for sponsored flow)
  // -------------------------------------------------------------------------

  private async signTransactionViaPrivy(
    transactionBase64: string,
  ): Promise<string> {
    const rpcBody = {
      method: "solana:signTransaction" as const,
      chain_type: "solana" as const,
      params: { transaction: transactionBase64 },
    };

    const result = await signedServerCall<{ signedTransaction: string }>(
      "/wallets/solana/sign-transaction",
      this._walletId,
      rpcBody,
      {
        walletAddress: this._address,
        walletId: this._walletId,
        transaction: transactionBase64,
      },
      this._signerPrivateKey,
      this._serverUrl,
      this._privyAppId,
      this._signFn,
    );

    return result.signedTransaction;
  }

  // -------------------------------------------------------------------------
  // sendInstructions
  // -------------------------------------------------------------------------

  override async sendInstructions(
    instructions: SolanaInstructionLike[],
  ): Promise<string> {
    const { value: latestBlockhash } = await this._rpc
      .getLatestBlockhash()
      .send();

    const useSponsorship =
      this._rpcProxyUrl && this._getAuthToken && this._gasPolicyId;

    if (useSponsorship) {
      return this.sendSponsoredTransaction(instructions, latestBlockhash);
    }
    return this.sendSelfPayTransaction(instructions, latestBlockhash);
  }

  /**
   * Standard flow: user pays own fees.
   */
  private async sendSelfPayTransaction(
    instructions: SolanaInstructionLike[],
    latestBlockhash: any,
  ): Promise<string> {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(this._signer.address, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions(instructions, msg),
      (msg) => addSignersToTransactionMessage([this._signer], msg),
    );

    const signedTx = await signTransactionMessageWithSigners(message);
    const encodedTx = getBase64EncodedWireTransaction(signedTx);
    return this.broadcastAndConfirm(encodedTx);
  }

  /**
   * Sponsored flow:
   * 1. Build tx with Alchemy placeholder fee payer
   * 2. alchemy_requestFeePayer → Alchemy replaces payer & adds its sig
   * 3. Privy signs the sponsored tx (adds user sig)
   * 4. Broadcast
   */
  private async sendSponsoredTransaction(
    instructions: SolanaInstructionLike[],
    latestBlockhash: any,
  ): Promise<string> {
    // 1. Build tx with placeholder fee payer
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) =>
        setTransactionMessageFeePayer(ALCHEMY_PLACEHOLDER_PAYER, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions(instructions, msg),
    );

    const compiled = compileTransaction(message);
    const wireBytes = getTransactionEncoder().encode(compiled);
    const unsignedBase64 = Buffer.from(wireBytes).toString("base64");

    // 2. Request gas sponsorship
    const sponsoredBase64 = await this.requestFeePayer(unsignedBase64);

    // 3. Sign with Privy (user's signature)
    const signedBase64 = await this.signTransactionViaPrivy(sponsoredBase64);

    // 4. Broadcast
    return this.broadcastAndConfirm(signedBase64);
  }

  // -------------------------------------------------------------------------
  // Broadcast + confirm
  // -------------------------------------------------------------------------

  private async broadcastAndConfirm(encodedTx: string): Promise<string> {
    let signature: Signature;
    try {
      signature = await this._rpc
        .sendTransaction(encodedTx as any, { encoding: "base64" })
        .send();
    } catch (err: unknown) {
      const errObj = err as Record<string, unknown>;
      const context = errObj?.context as Record<string, unknown> | undefined;
      const cause = errObj?.cause as Record<string, unknown> | undefined;
      const logs =
        (context?.logs as string[]) ??
        (cause?.logs as string[]) ??
        (errObj?.logs as string[]);
      if (logs?.length) {
        throw new Error(
          `Transaction simulation failed:\n${logs.join("\n")}`,
        );
      }
      throw err;
    }

    for (let i = 0; i < 30; i++) {
      const { value } = await this._rpc
        .getSignatureStatuses([signature])
        .send();
      const status = value[0];
      if (status) {
        if (status.err) {
          throw new Error(
            `Transaction failed: ${JSON.stringify(status.err)}`,
          );
        }
        if (
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"
        ) {
          return signature;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Transaction confirmation timeout: ${signature}`);
  }
}
