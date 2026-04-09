import type {
  AcpAgentDetail,
  AcpJobApi,
  BrowseAgentParams,
  OffChainJob,
} from "./types";
import { AcpHttpClient, type AcpHttpClientOptions } from "./acpHttpClient";

export class AcpApiClient extends AcpHttpClient implements AcpJobApi {
  constructor(opts: AcpHttpClientOptions = {}) {
    super(opts);
  }

  async getActiveJobs(): Promise<OffChainJob[]> {
    await this.ensureAuthenticated();
    const res = await this.authedFetch(`${this.serverUrl}/jobs`);
    const data = (await res.json()) as {
      jobs: OffChainJob[];
    };
    return data.jobs || [];
  }

  async getJob(chainId: number, jobId: string): Promise<OffChainJob | null> {
    await this.ensureAuthenticated();
    const res = await this.authedFetch(
      `${this.serverUrl}/jobs/${chainId}/${jobId}`
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { data: OffChainJob | null };
    return body.data ?? null;
  }

  async postDeliverable(
    chainId: number,
    jobId: string,
    deliverable: string
  ): Promise<void> {
    await this.ensureAuthenticated();
    const res = await this.authedFetch(
      `${this.serverUrl}/jobs/${chainId}/${jobId}/deliverable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliverable }),
      }
    );

    if (!res.ok) {
      throw new Error(
        `postDeliverable failed: ${res.status} ${res.statusText}`
      );
    }
  }

  async browseAgents(
    keyword: string,
    chainIds: number[],
    params?: BrowseAgentParams
  ): Promise<Array<AcpAgentDetail>> {
    await this.ensureAuthenticated();
    const query = new URLSearchParams({ query: keyword });
    if (chainIds.length > 0) query.set("chainIds", chainIds.join(","));
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const res = await this.authedFetch(
      `${this.serverUrl}/agents/search?${query.toString()}`
    );
    if (!res.ok) {
      throw new Error(`browseAgents failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()).data;
  }

  async getAgentByWalletAddress(
    walletAddress: string
  ): Promise<AcpAgentDetail | null> {
    await this.ensureAuthenticated();
    const res = await this.authedFetch(
      `${this.serverUrl}/agents/wallet/${walletAddress}`
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(
        `getAgentByWalletAddress failed: ${res.status} ${res.statusText}`
      );
    }
    return (await res.json()).data;
  }
}
