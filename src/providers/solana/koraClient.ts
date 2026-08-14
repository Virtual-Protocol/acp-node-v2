/**
 * Minimal client for a Kora paymaster node, reached through the ACP server's
 * authenticated proxy (`/wallets/solana-kora-rpc/:chainId`).
 *
 * Kora fills the fee-payer slot on a transaction and accepts an SPL token as
 * payment: the SDK builds a transaction with Kora's payer as fee payer plus a
 * payment instruction (agent -> Kora), the agent signs, and Kora co-signs as
 * fee payer. This client speaks only the read/quote/sign subset — it never asks
 * Kora to broadcast (`signAndSendTransaction`), because the adapter broadcasts
 * through its own `broadcastAndConfirm` to keep `minContextSlot` and the expiry
 * semantics.
 *
 * Transport mirrors `PrivySolanaProviderAdapter.requestFeePayer`: plain `fetch`
 * JSON-RPC with a bearer token, no extra dependency.
 *
 * FIELD NAMES are confirmed against a live node (devnet, kora-cli 2.2.x):
 * responses are snake_case (`signer_address`, `fee_in_lamports`,
 * `signed_transaction`); the camelCase fallbacks below are belt-and-braces.
 * They are intentionally isolated to this file so a mismatch is a one-place fix.
 *
 * There is deliberately no getPaymentInstruction here: that method does not
 * exist in Kora (its getConfig.enabled_methods lists liveness, get_config,
 * get_blockhash, get_supported_tokens, get_payer_signer,
 * estimate_transaction_fee, sign_transaction, get_version and the bundle
 * variants, and nothing else). The SDK builds the SPL payment itself and Kora
 * validates it inside sign_transaction.
 */
import type { Address } from "@solana/kit";

export interface KoraFeeQuote {
  /** Network + rent cost in lamports, before margin. */
  feeInLamports: bigint;
  /** Amount owed in the chosen fee token's base units, margin included. */
  feeInToken: bigint;
}

export interface KoraPayer {
  /** The fee-payer address Kora will co-sign with. */
  signerAddress: Address;
  /** Where the SPL payment must send the fee token. */
  paymentAddress: Address;
}

export class KoraClient {
  private readonly url: string;
  private readonly getToken: () => Promise<string>;

  constructor(params: { url: string; getToken: () => Promise<string> }) {
    this.url = params.url;
    this.getToken = params.getToken;
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = (await res.json()) as {
      result?: T;
      // JSON-RPC shape, from Kora itself.
      error?: { message?: string; code?: number } | string;
      // Nest's HttpException shape, from the authenticated proxy sitting in
      // front of it: {message, error: "Bad Request", statusCode}. Here `error`
      // is a STRING, so reading `.message` off it yields undefined and the
      // real reason — which lives in `message` — is discarded. Every proxy
      // rejection then reads as the useless `Kora <method> failed:
      // "Bad Request"`, which is what sent one debugging session after the
      // node instead of the route in front of it.
      message?: string;
      statusCode?: number;
    };
    if (json.error || json.result === undefined) {
      const reason =
        (typeof json.error === "object" ? json.error?.message : undefined) ??
        json.message ??
        (typeof json.error === "string" ? json.error : undefined) ??
        JSON.stringify(json.error ?? "no result");
      const status =
        json.statusCode !== undefined ? ` (HTTP ${json.statusCode})` : "";
      throw new Error(`Kora ${method} failed${status}: ${reason}`);
    }
    return json.result;
  }

  /** Kora's fee payer + payment destination. Stable per node; cache upstream. */
  async getPayerSigner(): Promise<KoraPayer> {
    const r = await this.call<{
      signer_address?: string;
      payment_address?: string;
      signerAddress?: string;
      paymentAddress?: string;
    }>("getPayerSigner", {});
    const signer = r.signer_address ?? r.signerAddress;
    const payment = r.payment_address ?? r.paymentAddress ?? signer;
    if (!signer) {
      throw new Error("Kora getPayerSigner returned no signer address");
    }
    return {
      signerAddress: signer as Address,
      paymentAddress: payment as Address,
    };
  }

  /**
   * The mints this node accepts as fee payment — its `allowed_spl_paid_tokens`.
   *
   * Static per deployment: the policy file is baked into the Kora image at
   * build time, so this cannot change under a running process. Callers should
   * resolve it once per chain and cache, not ask per transaction.
   *
   * Returns an unordered list. Kora expresses acceptance, not preference — the
   * priority order is the SDK's decision (see `resolveFeeTokens`).
   */
  async getSupportedTokens(): Promise<string[]> {
    const r = await this.call<{ tokens?: string[] }>("getSupportedTokens", {});
    return r.tokens ?? [];
  }

  /** Quote the fee for a base64 transaction, in lamports and the fee token. */
  async estimateTransactionFee(
    transactionBase64: string,
    feeToken: string,
  ): Promise<KoraFeeQuote> {
    const r = await this.call<{
      fee_in_lamports?: number | string;
      fee_in_token?: number | string;
      feeInLamports?: number | string;
      feeInToken?: number | string;
    }>("estimateTransactionFee", {
      transaction: transactionBase64,
      fee_token: feeToken,
    });
    const lamports = r.fee_in_lamports ?? r.feeInLamports ?? 0;
    const token = r.fee_in_token ?? r.feeInToken ?? 0;
    return {
      feeInLamports: BigInt(lamports),
      feeInToken: BigInt(token),
    };
  }

  /** Co-sign as fee payer; returns the fully-signed base64 transaction. */
  async signTransaction(transactionBase64: string): Promise<string> {
    const r = await this.call<{
      signed_transaction?: string;
      signedTransaction?: string;
    }>("signTransaction", { transaction: transactionBase64 });
    const signed = r.signed_transaction ?? r.signedTransaction;
    if (!signed) {
      throw new Error("Kora signTransaction returned no signed transaction");
    }
    return signed;
  }
}
