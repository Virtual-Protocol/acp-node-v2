import type { Address, Log } from "viem";
import { ACP_ABI } from "../core/acpAbi";
import { EvmAcpClient } from "../clients/evmAcpClient";
import type { IEvmProviderAdapter } from "../providers/types";
import { decodeAcpLogs } from "./decoder";
import type {
  AcpEventHandlers,
  AcpJobEvent,
  AcpTransport,
  TransportContext,
} from "./types";

const ACP_EVENTS = ACP_ABI.filter((item) => item.type === "event");

function addressEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Returns true when the event involves the given agent address
 * (as client, provider, evaluator, or rejector).
 */
/**
 * Returns true when the event involves the given agent address.
 *
 * Events like JobCreated carry all parties, so we can filter precisely.
 * Events like JobFunded/JobSubmitted/JobCompleted/JobRejected only carry
 * one party's address, but the *other* party also needs to react. Since
 * the missing address isn't in the log, we pass these through and let
 * the handler decide relevance (typically by checking the job ID).
 */
function eventInvolvesAgent(event: AcpJobEvent, agent: string): boolean {
  switch (event.type) {
    case "job.created":
      return (
        addressEq(event.client, agent) ||
        addressEq(event.provider, agent) ||
        addressEq(event.evaluator, agent)
      );
    case "job.funded":
    case "job.submitted":
    case "job.completed":
    case "job.rejected":
    case "budget.set":
    case "job.expired":
      return true;
  }
}

function dispatch(
  event: AcpJobEvent,
  handlers: AcpEventHandlers,
  ctx: TransportContext
): void {
  const handler = {
    "job.created": handlers.onJobCreated,
    "budget.set": handlers.onBudgetSet,
    "job.funded": handlers.onJobFunded,
    "job.submitted": handlers.onJobSubmitted,
    "job.completed": handlers.onJobCompleted,
    "job.rejected": handlers.onJobRejected,
    "job.expired": undefined,
  }[event.type];

  if (handler) {
    handler(event as any, ctx.agent).catch((err) => {
      console.error(`[PollingTransport] handler error for ${event.type}:`, err);
    });
  }
}

export type PollingTransportOptions = {
  pollIntervalMs?: number;
  fromBlock?: bigint;
};

export class PollingTransport implements AcpTransport {
  private readonly pollIntervalMs: number;
  private readonly initialFromBlock: bigint | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastProcessedBlock: bigint = 0n;
  private polling = false;

  constructor(opts?: PollingTransportOptions) {
    this.pollIntervalMs = opts?.pollIntervalMs ?? 3000;
    this.initialFromBlock = opts?.fromBlock;
  }

  async start(
    ctx: TransportContext,
    handlers: AcpEventHandlers
  ): Promise<void> {
    if (!(ctx.client instanceof EvmAcpClient)) {
      throw new Error(
        "PollingTransport currently only supports EVM clients."
      );
    }

    const provider: IEvmProviderAdapter = ctx.client.getProvider();
    const contractAddress = ctx.contractAddress as Address;

    this.lastProcessedBlock =
      this.initialFromBlock ?? (await provider.getBlockNumber());

    const poll = async () => {
      if (this.polling) return;
      this.polling = true;

      try {
        const currentBlock = await provider.getBlockNumber();
        if (currentBlock <= this.lastProcessedBlock) return;

        const logs: Log[] = await provider.getLogs({
          address: contractAddress,
          events: ACP_EVENTS,
          fromBlock: this.lastProcessedBlock + 1n,
          toBlock: currentBlock,
        });

        const events = decodeAcpLogs(logs);

        for (const event of events) {
          if (eventInvolvesAgent(event, ctx.agentAddress)) {
            dispatch(event, handlers, ctx);
          }
        }

        this.lastProcessedBlock = currentBlock;
      } catch (err) {
        console.error("[PollingTransport] poll error:", err);
      } finally {
        this.polling = false;
      }
    };

    await poll();

    this.timer = setInterval(poll, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
