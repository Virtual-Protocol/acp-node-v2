/**
 * Minimal client for a Kora paymaster node, reached through the ACP server's
 * authenticated proxy.
 *
 * Kora fills the fee-payer slot and accepts an SPL token as payment: the SDK
 * builds the transaction and the payment instruction, the agent signs, and Kora
 * co-signs. This client speaks only the read/quote/sign subset — the adapter
 * broadcasts itself, to keep `minContextSlot` and the expiry semantics.
 *
 * Transport is plain `fetch` JSON-RPC with a bearer token. Responses are
 * snake_case; the camelCase fallbacks are belt-and-braces, isolated here so a
 * mismatch is a one-place fix. The SDK builds the SPL payment itself, which
 * Kora validates inside sign_transaction.
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

/**
 * An error from a Kora call, carrying the sponsor proxy's structured refusal
 * when there was one. Property widening rather than a subclass, so callers can
 * duck-type it without an `instanceof` across a bundling boundary.
 */
export interface KoraRpcError extends Error {
  /** SIMULATION_FAILED | POLICY_DENIED | RATE_LIMITED | UNAVAILABLE */
  sponsorCode?: string;
  /** Whether an identical retry could plausibly succeed. */
  sponsorRetryable?: boolean;
}

/** Reads the proxy's `retryable` verdict off an error, if it carried one. */
export function sponsorRetryableVerdict(err: unknown): boolean | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const v = (err as { sponsorRetryable?: unknown }).sponsorRetryable;
  return typeof v === "boolean" ? v : undefined;
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
      // The proxy in front of it answers with a different shape, where `error`
      // is a STRING and the real reason lives in `message`.
      message?: string;
      statusCode?: number;
      // The machine-readable half of a refusal: `code` is what a caller
      // branches on, `retryable` what it acts on. Must stay declared — a field
      // absent from this type is silently parsed away.
      data?: {
        code?: string;
        retryable?: boolean;
        /** Present only where the cluster enables verbose refusals. */
        rule?: string;
        detail?: string;
      };
    };
    if (json.error || json.result === undefined) {
      const reason =
        (typeof json.error === "object" ? json.error?.message : undefined) ??
        json.message ??
        (typeof json.error === "string" ? json.error : undefined) ??
        JSON.stringify(json.error ?? "no result");
      const status =
        json.statusCode !== undefined ? ` (HTTP ${json.statusCode})` : "";
      // Gated per cluster and usually absent; when present it names which
      // check refused.
      const diag = json.data?.rule
        ? ` [${json.data.rule}${json.data.detail ? `: ${json.data.detail}` : ""}]`
        : "";
      const code = json.data?.code ? ` (${json.data.code})` : "";
      const err = new Error(
        `Kora ${method} failed${status}: ${reason}${code}${diag}`,
      ) as KoraRpcError;
      if (json.data?.code !== undefined) err.sponsorCode = json.data.code;
      if (json.data?.retryable !== undefined) {
        err.sponsorRetryable = json.data.retryable;
      }
      throw err;
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
   * The mints this node accepts as fee payment. Static per deployment, so
   * resolve once per chain and cache rather than asking per transaction.
   *
   * Unordered: Kora expresses acceptance, not preference. Priority is the
   * SDK's decision (see `resolveFeeTokens`).
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

  /**
   * Submits an UNFUNDED transaction — ACP instructions only, no System
   * transfers and no ComputeBudget content — and returns the transaction to
   * sign plus the lamports it was funded by. The SDK signs the returned bytes
   * exactly as received; `neededLamports` of 0 means they came back unchanged.
   *
   * `forceMaxCuLimit` requests the maximum compute limit — the retry backstop
   * after compute exhaustion.
   */
  async prepareSponsoredTransaction(
    transactionBase64: string,
    options?: { forceMaxCuLimit?: boolean },
  ): Promise<{
    transaction: string;
    neededLamports: bigint;
  }> {
    const r = await this.call<{
      transaction?: string;
      needed_lamports?: number | string;
      neededLamports?: number | string;
    }>("prepareSponsoredTransaction", {
      transaction: transactionBase64,
      ...(options?.forceMaxCuLimit ? { forceMaxCuLimit: true } : {}),
    });
    if (!r.transaction) {
      throw new Error(
        "Kora prepareSponsoredTransaction returned no transaction",
      );
    }
    return {
      transaction: r.transaction,
      neededLamports: BigInt(r.needed_lamports ?? r.neededLamports ?? 0),
    };
  }

  /**
   * The upstream's effective configuration. Read to decide whether this client
   * may sign in PARALLEL with the co-signer, which is sound only when the
   * co-signer writes nothing but its own signature slot.
   *
   * Untyped: only a couple of paths matter, so a typed mirror would rot.
   */
  async getConfig(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("getConfig", {});
  }

  /**
   * Co-sign as fee payer; returns the fully-signed base64 transaction.
   *
   * `signerKey` pins WHICH payer signs, and is required against a node running
   * more than one signer: the pool rotates per RPC call and a transaction costs
   * two, so an unpinned sign can come from a payer the transaction never named.
   *
   * Optional because the sponsor path reaches Kora through a proxy that sets
   * `signer_key` from the transaction's own fee-payer field.
   */
  async signTransaction(
    transactionBase64: string,
    options?: { signerKey?: string },
  ): Promise<string> {
    const r = await this.call<{
      signed_transaction?: string;
      signedTransaction?: string;
    }>("signTransaction", {
      transaction: transactionBase64,
      ...(options?.signerKey ? { signer_key: options.signerKey } : {}),
    });
    const signed = r.signed_transaction ?? r.signedTransaction;
    if (!signed) {
      throw new Error("Kora signTransaction returned no signed transaction");
    }
    return signed;
  }
}
