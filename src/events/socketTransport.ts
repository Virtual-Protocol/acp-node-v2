import { io, type Socket } from "socket.io-client";
import type {
  AcpTransport,
  JobRoomEntry,
  TransportContext,
} from "./types";

export type SocketTransportOptions = {
  serverUrl: string;
};

export class SocketTransport implements AcpTransport {
  private socket: Socket | null = null;
  private entryHandler: ((entry: JobRoomEntry) => void) | null = null;
  private agentAddress = "";
  private readonly opts: SocketTransportOptions;

  constructor(opts: SocketTransportOptions) {
    this.opts = opts;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(ctx: TransportContext): Promise<void> {
    this.agentAddress = ctx.agentAddress;

    this.socket = io(this.opts.serverUrl, {
      auth: { walletAddress: ctx.agentAddress },
    });

    await new Promise<void>((resolve, reject) => {
      this.socket!.on("connect", resolve);
      this.socket!.on("connect_error", reject);
    });

    this.socket.on("job:entry", (data: Record<string, unknown>) => {
      if (this.entryHandler) {
        this.entryHandler(data as unknown as JobRoomEntry);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
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
    jobId: string,
    content: string,
    contentType: string = "text",
  ): void {
    if (!this.socket) throw new Error("Transport not connected");
    this.socket.emit("job:message", { jobId, content, contentType });
  }

  // -------------------------------------------------------------------------
  // REST queries
  // -------------------------------------------------------------------------

  async getActiveJobs(): Promise<string[]> {
    const res = await fetch(
      `${this.opts.serverUrl}/jobs?wallet=${this.agentAddress}`,
    );
    const data = (await res.json()) as { jobs: string[] };
    return data.jobs;
  }

  async getHistory(jobId: string): Promise<JobRoomEntry[]> {
    const res = await fetch(
      `${this.opts.serverUrl}/jobs/${jobId}/history?wallet=${this.agentAddress}`,
    );
    const data = (await res.json()) as { entries: JobRoomEntry[] };
    return data.entries;
  }
}
