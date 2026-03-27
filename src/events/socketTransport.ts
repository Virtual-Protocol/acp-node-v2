import { io, type Socket } from "socket.io-client";
import type {
  AcpTransport,
  JobRoomEntry,
  OffChainJob,
  TransportContext,
} from "./types";
import { SOCKET_SERVER_URL } from "../core/constants";

export type SocketTransportOptions = {
  serverUrl?: string;
};

export class SocketTransport implements AcpTransport {
  private socket: Socket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private entryHandler: ((entry: JobRoomEntry) => void) | null = null;
  private ctx: TransportContext | null = null;
  private token = "";
  private readonly opts: Required<SocketTransportOptions>;

  constructor(opts: SocketTransportOptions = {}) {
    this.opts = {
      serverUrl: opts.serverUrl ?? SOCKET_SERVER_URL,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(
    ctx: TransportContext,
    onConnected?: () => void
  ): Promise<void> {
    this.ctx = ctx;
    this.token = await this.authenticate();

    this.socket = io(this.opts.serverUrl, {
      auth: async (cb) => {
        try {
          await this.refreshTokenIfNeeded();
        } catch {
          /* proceed with current token */
        }
        cb({ token: this.token });
      },
    });

    await new Promise<void>((resolve, reject) => {
      this.socket!.on("connect", resolve);
      this.socket!.on("connect_error", reject);
    });

    onConnected?.();

    this.socket.on("job:entry", (data: Record<string, unknown>) => {
      if (this.entryHandler) {
        this.entryHandler(data as unknown as JobRoomEntry);
      }
    });

    this.heartbeatInterval = setInterval(() => {
      this.socket?.emit("heartbeat");
    }, 30_000);
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.ctx = null;
    this.entryHandler = null;
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  private async authenticate(): Promise<string> {
    if (!this.ctx) throw new Error("Transport not connected");

    const chainId = this.ctx.providerSupportedChainIds[0];

    const message = `acp-auth:${Date.now()}`;
    const signature = await this.ctx.signMessage(chainId!, message);

    const res = await fetch(`${this.opts.serverUrl}/auth/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: this.ctx.agentAddress,
        signature,
        message,
        chainId,
      }),
    });

    if (!res.ok) {
      throw new Error(`Agent auth failed: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as { data: { token: string } };
    return body.data.token;
  }

  /** Returns true if the token expiry is within 60 s (or unparseable). */
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

  private async refreshTokenIfNeeded(): Promise<void> {
    if (this.isTokenExpiring()) {
      this.token = await this.authenticate();
    }
  }

  // -------------------------------------------------------------------------
  // REST helpers
  // -------------------------------------------------------------------------

  private async authedFetch(url: string): Promise<Response> {
    let res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (res.status === 401) {
      this.token = await this.authenticate();
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
    }

    return res;
  }

  // -------------------------------------------------------------------------
  // Entry handler
  // -------------------------------------------------------------------------

  onEntry(handler: (entry: JobRoomEntry) => void): void {
    this.entryHandler = handler;
  }

  // -------------------------------------------------------------------------
  // Messaging (real-time via socket)
  // -------------------------------------------------------------------------

  sendMessage(
    chainId: number,
    jobId: string,
    content: string,
    contentType: string = "text"
  ): void {
    if (!this.socket) throw new Error("Transport not connected");
    this.socket.emit("job:message", {
      chainId,
      onChainJobId: jobId,
      content,
      contentType,
    });
  }

  // -------------------------------------------------------------------------
  // REST queries
  // -------------------------------------------------------------------------

  async getActiveJobs(): Promise<{ chainId: number; onChainJobId: string }[]> {
    const res = await this.authedFetch(`${this.opts.serverUrl}/jobs`);
    const data = (await res.json()) as {
      jobs: {
        chainId: number;
        onChainJobId: string;
      }[];
    };
    return data.jobs || [];
  }

  async getHistory(chainId: number, jobId: string): Promise<JobRoomEntry[]> {
    const res = await this.authedFetch(
      `${this.opts.serverUrl}/jobs/${chainId}/${jobId}/history`
    );
    const data = (await res.json()) as { entries: JobRoomEntry[] };
    return data.entries;
  }

  async getJob(
    chainId: number,
    jobId: string
  ): Promise<OffChainJob | null> {
    const res = await this.authedFetch(
      `${this.opts.serverUrl}/jobs/${chainId}/${jobId}`
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { data: OffChainJob | null };
    return body.data ?? null;
  }
}
