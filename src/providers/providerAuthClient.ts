import { ACP_SERVER_URL } from "../core/constants.js";

/**
 * Auth client for the ACP server's `/auth/agent` endpoint. Both EVM and Solana
 * authenticate by signing the plain `acp-auth:<timestamp>` challenge message;
 * the server picks the verification primitive by chain (ECDSA/EIP-7702 for EVM,
 * Ed25519 for Solana).
 */
export interface ProviderAuthClientOptions {
  serverUrl?: string;
  walletAddress: string;
  chainId: number;
  signMessage: (message: string) => Promise<string>;
}

export class ProviderAuthClient {
  private token = "";
  private readonly serverUrl: string;
  private readonly walletAddress: string;
  private readonly chainId: number;
  private readonly _signMessage: (message: string) => Promise<string>;

  constructor(opts: ProviderAuthClientOptions) {
    this.serverUrl = (opts.serverUrl ?? ACP_SERVER_URL).replace(/\/$/, "");
    this.walletAddress = opts.walletAddress;
    this.chainId = opts.chainId;
    this._signMessage = opts.signMessage;
  }

  async getAuthToken(): Promise<string> {
    if (!this.token || this.isTokenExpiring()) {
      this.token = await this.authenticate();
    }
    return this.token;
  }

  private async authenticate(): Promise<string> {
    const message = `acp-auth:${Date.now()}`;
    const signature = await this._signMessage(message);

    const res = await fetch(`${this.serverUrl}/auth/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: this.walletAddress,
        signature,
        message,
        chainId: this.chainId,
      }),
    });

    if (!res.ok) {
      throw new Error(`Agent auth failed: ${res.status} ${res.statusText}`);
    }

    const parsed = (await res.json()) as { data: { token: string } };
    return parsed.data.token;
  }

  private isTokenExpiring(): boolean {
    try {
      const parts = this.token.split(".");
      if (!parts[1]) return true;
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      return (payload.exp ?? 0) * 1000 - Date.now() < 60_000;
    } catch {
      return true;
    }
  }
}
