import { EventSource } from "eventsource";
import type { AcpChatTransport, JobRoomEntry } from "./types";
import { AcpHttpClient, type AcpHttpClientOptions } from "./acpHttpClient";

export type SseTransportOptions = AcpHttpClientOptions;

export class SseTransport extends AcpHttpClient implements AcpChatTransport {
  private eventSource: EventSource | null = null;
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

    this.eventSource = new EventSource(`${this.serverUrl}/chats/stream`, {
      fetch: async (url, init) => {
        await this.refreshTokenIfNeeded();
        return fetch(url, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            Authorization: `Bearer ${this.token}`,
          },
        });
      },
    });

    await new Promise<void>((resolve, reject) => {
      this.eventSource!.onopen = () => resolve();
      this.eventSource!.onerror = (err) => {
        if (this.eventSource!.readyState === EventSource.CONNECTING) return;
        reject(err);
      };
    });

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
      }:${
        "content" in entry ? entry.content : (entry as any).event?.type
      }`;
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

  }

  async disconnect(): Promise<void> {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
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
    contentType: string = "text"
  ): void {
    this.postMessage(chainId, jobId, content, contentType).catch(
      console.error
    );
  }

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
