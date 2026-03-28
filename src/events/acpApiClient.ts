import type { AcpJobApi, OffChainJob } from "./types";
import { AcpHttpClient, type AcpHttpClientOptions } from "./acpHttpClient";

export class AcpApiClient extends AcpHttpClient implements AcpJobApi {
  constructor(opts: AcpHttpClientOptions = {}) {
    super(opts);
  }

  async getActiveJobs(): Promise<{ chainId: number; onChainJobId: string }[]> {
    await this.ensureAuthenticated();
    const res = await this.authedFetch(`${this.serverUrl}/jobs`);
    const data = (await res.json()) as {
      jobs: {
        chainId: number;
        onChainJobId: string;
      }[];
    };
    return data.jobs || [];
  }

  async getJob(
    chainId: number,
    jobId: string
  ): Promise<OffChainJob | null> {
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
}
