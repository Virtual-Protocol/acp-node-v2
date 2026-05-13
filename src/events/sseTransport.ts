import { EventSource } from "eventsource";
import type { AcpChatTransport, JobRoomEntry } from "./types.js";
import { AcpHttpClient, type AcpHttpClientOptions } from "./acpHttpClient.js";
import { resolveApproval, type ApprovalEvent } from "../core/approvalGate.js";

export type SseTransportOptions = AcpHttpClientOptions;

export class SseTransport extends AcpHttpClient implements AcpChatTransport {
  private eventSource: EventSource | null = null;
  private walletEventSource: EventSource | null = null;
  private entryHandler: ((entry: JobRoomEntry) => void) | null = null;
  private lastEventTimestamp: number | null = null;
  private seenEntries = new Set<string>();

  constructor(opts: SseTransportOptions = {}) {
    super(opts);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(onConnected?: () => void): Promise<void> {
    await this.ensureAuthenticated();

    let chatStream: EventSource | null = null;
    let walletStream: EventSource | null = null;
    try {
      [chatStream, walletStream] = await Promise.all([
        this.openStream("/chats/stream"),
        this.openStream("/wallets/stream"),
      ]);
    } catch (err) {
      chatStream?.close();
      walletStream?.close();
      throw err;
    }

    this.eventSource = chatStream;
    this.walletEventSource = walletStream;

    onConnected?.();

    this.eventSource.onmessage = (event) => {
      if (!event.data) return;

      let entry: JobRoomEntry;
      try {
        entry = JSON.parse(event.data);
      } catch {
        return;
      }

      const key = `${entry.timestamp}:${entry.kind}:${
        "from" in entry ? entry.from : ""
      }:${"content" in entry ? entry.content : (entry as any).event?.type}`;
      if (this.seenEntries.has(key)) return;
      this.seenEntries.add(key);

      this.lastEventTimestamp = Math.max(
        this.lastEventTimestamp ?? 0,
        entry.timestamp
      );

      if (this.entryHandler) {
        this.entryHandler(entry);
      }
    };

    this.walletEventSource.onmessage = (event) => {
      if (!event.data) return;

      let entry: ApprovalEvent;
      try {
        entry = JSON.parse(event.data);
      } catch {
        return;
      }

      resolveApproval(
        entry.approvalId,
        entry.status,
        entry.result,
        entry.reason
      );
    };
  }

  async disconnect(): Promise<void> {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.walletEventSource) {
      this.walletEventSource.close();
      this.walletEventSource = null;
    }
    this.ctx = null;
    this.entryHandler = null;
    this.lastEventTimestamp = null;
    this.seenEntries.clear();
  }

  // -------------------------------------------------------------------------
  // Entry handler
  // -------------------------------------------------------------------------

  onEntry(handler: (entry: JobRoomEntry) => void): void {
    this.entryHandler = handler;
  }

  // -------------------------------------------------------------------------
  // Messaging (via REST — SSE is server→client only)
  // -------------------------------------------------------------------------

  sendMessage(
    chainId: number,
    jobId: string,
    content: string,
    contentType: string = "text",
    packageId?: number
  ): void {
    this.postMessage(chainId, jobId, content, contentType, packageId).catch(
      console.error
    );
  }

  async postMessage(
    chainId: number,
    jobId: string,
    content: string,
    contentType: string = "text",
    packageId?: number
  ): Promise<void> {
    await this.ensureAuthenticated();
    const res = await this.authedFetch(
      `${this.serverUrl}/chats/${chainId}/${jobId}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, contentType, packageId }),
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

  private openStream(path: string): Promise<EventSource> {
    const source = new EventSource(`${this.serverUrl}${path}`, {
      fetch: async (url, init) => {
        await this.refreshTokenIfNeeded();
        return fetch(url, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            Authorization: `Bearer ${this.token}`,
            "x-supported-chains": JSON.stringify(
              this.ctx?.providerSupportedChainIds ?? []
            ),
          },
        });
      },
    });

    return new Promise<EventSource>((resolve, reject) => {
      source.onopen = () => resolve(source);
      source.onerror = (err) => {
        if (source.readyState === EventSource.CONNECTING) return;
        source.close();
        reject(err);
      };
    });
  }
}
