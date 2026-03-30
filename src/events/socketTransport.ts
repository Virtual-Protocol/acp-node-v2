import { io, type Socket } from "socket.io-client";
import type { AcpChatTransport, JobRoomEntry, TransportContext } from "./types";
import { AcpHttpClient, type AcpHttpClientOptions } from "./acpHttpClient";

export type SocketTransportOptions = AcpHttpClientOptions;

export class SocketTransport extends AcpHttpClient implements AcpChatTransport {
  private socket: Socket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private entryHandler: ((entry: JobRoomEntry) => void) | null = null;

  constructor(opts: SocketTransportOptions = {}) {
    super(opts);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(onConnected?: () => void): Promise<void> {
    await this.ensureAuthenticated();

    this.socket = io(this.serverUrl, {
      transports: ["websocket"],
      extraHeaders: {
        "x-supported-chains": JSON.stringify(
          this.ctx?.providerSupportedChainIds ?? []
        ),
      },
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
  // One-shot REST messaging (no socket connection needed)
  // -------------------------------------------------------------------------

  async postMessage(
    chainId: number,
    jobId: string,
    content: string,
    contentType: string = "text"
  ): Promise<void> {
    await this.ensureAuthenticated();
    const res = await this.authedFetch(
      `${this.serverUrl}/chats/${chainId}/${jobId}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, contentType }),
      }
    );

    if (!res.ok) {
      throw new Error(`postMessage failed: ${res.status} ${res.statusText}`);
    }
  }

  // -------------------------------------------------------------------------
  // Chat history
  // -------------------------------------------------------------------------

  async getHistory(chainId: number, jobId: string): Promise<JobRoomEntry[]> {
    await this.ensureAuthenticated();
    const res = await this.authedFetch(
      `${this.serverUrl}/chats/${chainId}/${jobId}/history`
    );
    const data = (await res.json()) as { entries: JobRoomEntry[] };
    return data.entries;
  }
}
