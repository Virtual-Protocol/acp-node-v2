import type { Address } from "viem";
import type { TransportContext } from "./types.js";
import { ACP_SERVER_URL, getChainFamily } from "../core/constants.js";
import { buildAgentAuthTypedData } from "../core/agentAuth.js";

export type AcpHttpClientOptions = {
  serverUrl?: string;
};

export class AcpHttpClient {
  protected ctx: TransportContext | null = null;
  protected token = "";
  protected readonly serverUrl: string;

  constructor(opts: AcpHttpClientOptions = {}) {
    this.serverUrl = opts.serverUrl ?? ACP_SERVER_URL;
  }

  setContext(ctx: TransportContext): void {
    this.ctx = ctx;
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.token || this.isTokenExpiring()) {
      this.token = await this.authenticate();
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  protected async authenticate(): Promise<string> {
    if (!this.ctx) throw new Error("Transport context not set");

    const chainId = this.ctx.providerSupportedChainIds[0];
    if (chainId == null) {
      throw new Error("No provider-supported chain available for auth");
    }

    const walletAddress =
      this.ctx.agentAddresses[getChainFamily(chainId)] ??
      Object.values(this.ctx.agentAddresses)[0] ??
      "";

    let authBody: Record<string, unknown>;
    if (getChainFamily(chainId) === "solana") {
      const message = `acp-auth:${Date.now()}`;
      const signature = await this.ctx.signMessage(chainId, message);
      authBody = { walletAddress, signature, message, chainId };
    } else {
      const issuedAt = Date.now();
      const typedData = buildAgentAuthTypedData({
        wallet: walletAddress as Address,
        chainId,
        issuedAt,
      });
      const signature = await this.ctx.signTypedData(chainId, typedData);
      authBody = { walletAddress, signature, issuedAt, chainId };
    }

    const res = await fetch(`${this.serverUrl}/auth/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authBody),
    });

    if (!res.ok) {
      throw new Error(`Agent auth failed: ${res.status} ${res.statusText}`);
    }

    const responseBody = (await res.json()) as { data: { token: string } };
    return responseBody.data.token;
  }

  /** Returns true if the token expiry is within 60 s (or unparseable). */
  protected isTokenExpiring(): boolean {
    try {
      const parts = this.token.split(".");
      if (!parts[1]) return true;
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      return (payload.exp ?? 0) * 1000 - Date.now() < 60_000;
    } catch {
      return true;
    }
  }

  protected async refreshTokenIfNeeded(): Promise<void> {
    if (this.isTokenExpiring()) {
      this.token = await this.authenticate();
    }
  }

  // ---------------------------------------------------------------------------
  // REST helpers
  // ---------------------------------------------------------------------------

  protected async authedFetch(
    url: string,
    init?: RequestInit
  ): Promise<Response> {
    const doFetch = () =>
      fetch(url, {
        ...init,
        headers: {
          ...init?.headers,
          Authorization: `Bearer ${this.token}`,
        },
      });

    let res = await doFetch();
    if (res.status === 401) {
      this.token = await this.authenticate();
      res = await doFetch();
    }

    return res;
  }
}
