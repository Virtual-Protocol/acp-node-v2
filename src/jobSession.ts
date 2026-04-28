import type {
  JobRoomEntry,
  AgentMessage,
  SystemEntry,
  AcpTool,
  AcpToolParameter,
  AgentRole,
  AcpJobEventType,
} from "./events/types";
import type { AcpAgent } from "./acpAgent";
import { AcpJob } from "./acpJob";
import { AssetToken } from "./core/assetToken";
import { Address } from "viem";

// ---------------------------------------------------------------------------
// Derived job status from the room entry stream
// ---------------------------------------------------------------------------

type DerivedStatus =
  | "open"
  | "budget_set"
  | "funded"
  | "submitted"
  | "completed"
  | "rejected"
  | "expired";

const EVENT_TO_STATUS: Partial<Record<AcpJobEventType, DerivedStatus>> = {
  "job.created": "open",
  "budget.set": "budget_set",
  "job.funded": "funded",
  "job.submitted": "submitted",
  "job.completed": "completed",
  "job.rejected": "rejected",
  "job.expired": "expired",
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function param(
  name: string,
  type: string,
  description: string,
  required = true
): AcpToolParameter {
  return { name, type, description, required };
}

const TOOL_SEND_MESSAGE: AcpTool = {
  name: "sendMessage",
  description: "Send a message to the other parties in this job room.",
  parameters: [
    param("content", "string", "The message content"),
    param(
      "contentType",
      "string",
      "One of: text, proposal, deliverable, structured",
      false
    ),
  ],
};

const TOOL_SET_BUDGET: AcpTool = {
  name: "setBudget",
  description: "Propose a budget for this job (USDC amount).",
  parameters: [param("amount", "number", "USDC amount for the budget")],
};

const TOOL_FUND: AcpTool = {
  name: "fund",
  description: "Fund this job with the agreed budget (USDC amount).",
  parameters: [param("amount", "number", "USDC amount to fund")],
};

const TOOL_SUBMIT: AcpTool = {
  name: "submit",
  description: "Submit a deliverable for this job.",
  parameters: [
    param("deliverable", "string", "The deliverable content or reference"),
  ],
};

const TOOL_COMPLETE: AcpTool = {
  name: "complete",
  description: "Approve and complete this job.",
  parameters: [
    param("reason", "string", "Reason for completion / evaluation notes"),
  ],
};

const TOOL_REJECT: AcpTool = {
  name: "reject",
  description: "Reject this job or deliverable.",
  parameters: [param("reason", "string", "Reason for rejection")],
};

const TOOL_WAIT: AcpTool = {
  name: "wait",
  description:
    "Do nothing and wait. Use this when there is no action required from you right now.",
  parameters: [],
};

// ---------------------------------------------------------------------------
// Tool availability matrix: role x status -> tools
// ---------------------------------------------------------------------------

type ToolMatrix = Record<AgentRole, Partial<Record<DerivedStatus, AcpTool[]>>>;

const TOOL_MATRIX: ToolMatrix = {
  provider: {
    open: [TOOL_SET_BUDGET, TOOL_SEND_MESSAGE, TOOL_WAIT],
    budget_set: [TOOL_SET_BUDGET],
    funded: [TOOL_SUBMIT],
    submitted: [],
    completed: [],
    rejected: [],
  },
  client: {
    open: [TOOL_SEND_MESSAGE, TOOL_WAIT],
    budget_set: [TOOL_SEND_MESSAGE, TOOL_FUND, TOOL_WAIT],
    funded: [],
    submitted: [],
    completed: [],
    rejected: [],
  },
  evaluator: {
    open: [],
    budget_set: [],
    funded: [],
    submitted: [TOOL_COMPLETE, TOOL_REJECT],
    completed: [],
    rejected: [],
  },
};

// ---------------------------------------------------------------------------
// JobSession
// ---------------------------------------------------------------------------

export class JobSession {
  readonly jobId: string;
  readonly chainId: number;
  readonly roles: AgentRole[];
  readonly entries: JobRoomEntry[] = [];

  private _job: AcpJob | null = null;
  private readonly agent: AcpAgent;
  private readonly agentAddresses: Set<string>;

  constructor(
    agent: AcpAgent,
    agentAddresses: string[],
    jobId: string,
    chainId: number,
    roles: AgentRole[],
    initialEntries: JobRoomEntry[] = []
  ) {
    this.agent = agent;
    this.agentAddresses = new Set(agentAddresses.map((a) => a.toLowerCase()));
    this.jobId = jobId;
    this.chainId = chainId;
    this.roles = roles;
    this.entries.push(...initialEntries);
  }

  get job(): AcpJob | null {
    return this._job;
  }

  async fetchJob(): Promise<AcpJob> {
    try {
      const data = await this.agent.getApi().getJob(this.chainId, this.jobId);
      if (!data) {
        throw new Error(`Job ${this.jobId} not found on chain ${this.chainId}`);
      }
      this._job = AcpJob.fromOffChain(data);
      return this._job;
    } catch {
      throw new Error(
        `Failed to fetch job ${this.jobId} on chain ${this.chainId}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Entry management
  // -------------------------------------------------------------------------

  appendEntry(entry: JobRoomEntry): void {
    this.entries.push(entry);
  }

  // -------------------------------------------------------------------------
  // Derived status from entries
  // -------------------------------------------------------------------------

  get status(): DerivedStatus {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (entry.kind === "system") {
        const mapped = EVENT_TO_STATUS[entry.event.type as AcpJobEventType];
        if (mapped) return mapped;
      }
    }
    return "open";
  }

  // -------------------------------------------------------------------------
  // Response gating — should this entry trigger an LLM call?
  // -------------------------------------------------------------------------

  shouldRespond(entry: JobRoomEntry): boolean {
    if (entry.kind === "message") {
      return !this.agentAddresses.has(entry.from.toLowerCase());
    }

    const RESPONDERS: Record<string, AgentRole[]> = {
      "job.created": ["provider"],
      "budget.set": ["client"],
      "job.funded": ["provider"],
      "job.submitted": ["evaluator"],
      "job.completed": ["client", "provider"],
      "job.rejected": [],
    };

    const allowed = RESPONDERS[entry.event.type];
    if (!allowed) return false;
    return this.roles.some((r) => allowed.includes(r));
  }

  // -------------------------------------------------------------------------
  // Tool discovery
  // -------------------------------------------------------------------------

  availableTools(): AcpTool[] {
    const seen = new Set<string>();
    const tools: AcpTool[] = [];
    const st = this.status;

    for (const r of this.roles) {
      for (const t of TOOL_MATRIX[r][st] ?? []) {
        if (!seen.has(t.name)) {
          seen.add(t.name);
          tools.push(t);
        }
      }
    }

    if (tools.length === 0) tools.push(TOOL_WAIT);
    return tools;
  }

  // -------------------------------------------------------------------------
  // Tool execution
  // -------------------------------------------------------------------------

  async executeTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const available = this.availableTools().map((t) => t.name);
    if (!available.includes(name)) {
      throw new Error(
        `Tool "${name}" not available. Roles=${this.roles.join(",")}, status=${
          this.status
        }. Available: ${available.join(", ")}`
      );
    }

    switch (name) {
      case "wait":
        break;
      case "sendMessage":
        await this.sendMessage(
          args.content as string,
          (args.contentType as AgentMessage["contentType"]) ?? "text"
        );
        break;
      case "setBudget":
        await this.setBudget(
          AssetToken.usdc(args.amount as number, this.chainId)
        );
        break;
      case "fund":
        await this.fund(AssetToken.usdc(args.amount as number, this.chainId));
        break;
      case "submit":
        await this.submit(args.deliverable as string);
        break;
      case "complete":
        await this.complete(args.reason as string);
        break;
      case "reject":
        await this.reject(args.reason as string);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // -------------------------------------------------------------------------
  // Action methods (sugar over executeTool)
  // -------------------------------------------------------------------------

  async sendMessage(
    content: string,
    contentType: AgentMessage["contentType"] = "text"
  ): Promise<void> {
    this.agent.sendJobMessage(this.chainId, this.jobId, content, contentType);
  }

  async setBudget(amount: AssetToken): Promise<void> {
    await this.agent.internalSetBudget(this.chainId, {
      jobId: BigInt(this.jobId),
      amount,
      ...(this._job && { clientAddress: this._job.clientAddress }),
    });
  }

  async setBudgetWithFundRequest(
    amount: AssetToken,
    transferAmount: AssetToken,
    destination: Address
  ): Promise<void> {
    await this.agent.internalSetBudgetWithFundRequest(this.chainId, {
      jobId: BigInt(this.jobId),
      amount,
      transferAmount,
      destination,
      ...(this._job && { clientAddress: this._job.clientAddress }),
    });
  }

  async fund(amount?: AssetToken): Promise<void> {
    if (!this._job) throw new Error("Job not loaded");
    const effectiveAmount = amount ?? this._job.budget;
    const intent = this._job.getFundRequestIntent();

    if (intent) {
      const transferAmount = await intent.resolveAmount(
        this.chainId,
        this.agent.getClient(this.chainId)
      );

      if (!transferAmount) throw new Error("Could not resolve intent amount");
      await this.agent.internalFundWithTransfer(this.chainId, {
        jobId: BigInt(this.jobId),
        amount: effectiveAmount,
        transferAmount,
        destination: intent.recipientAddress as Address,
        clientAddress: this._job.clientAddress,
      });
    } else {
      await this.agent.internalFund(this.chainId, {
        jobId: BigInt(this.jobId),
        amount: effectiveAmount,
        clientAddress: this._job.clientAddress,
      });
    }
  }

  async submit(
    deliverable: string,
    transferAmount?: AssetToken
  ): Promise<void> {
    if (!this._job) throw new Error("Job not loaded");

    if (transferAmount) {
      await this.agent.internalSubmitWithTransfer(this.chainId, {
        jobId: BigInt(this.jobId),
        deliverable,
        transferAmount,
        clientAddress: this._job.clientAddress,
      });
    } else {
      await this.agent.internalSubmit(this.chainId, {
        jobId: BigInt(this.jobId),
        deliverable,
        clientAddress: this._job.clientAddress,
      });
    }
  }

  async complete(reason: string): Promise<void> {
    await this.agent.internalComplete(this.chainId, {
      jobId: BigInt(this.jobId),
      reason,
      ...(this._job && { clientAddress: this._job.clientAddress }),
    });
  }

  async reject(reason: string): Promise<void> {
    await this.agent.internalReject(this.chainId, {
      jobId: BigInt(this.jobId),
      reason,
      ...(this._job && { clientAddress: this._job.clientAddress }),
    });
  }

  // -------------------------------------------------------------------------
  // Context serialization
  // -------------------------------------------------------------------------

  async toContext(): Promise<string> {
    const lines: string[] = [];
    for (const e of this.entries) {
      if (e.kind === "system") {
        let line = `[system]  ${e.event.type} — ${JSON.stringify(e.event)}`;
        if (e.event.type === "budget.set" && this._job) {
          const fundRequest = this._job.getFundRequestIntent();
          if (fundRequest) {
            const resolved = await fundRequest.resolveAmount(
              this.chainId,
              this.agent.getClient(this.chainId)
            );
            if (resolved) {
              line += ` | fund request: ${resolved.amount} ${resolved.symbol} to ${fundRequest.recipientAddress}`;
            }
          }
        }
        if (e.event.type === "job.submitted") {
          const deliverable = this._job?.deliverable;
          if (deliverable) {
            line += ` | deliverable: ${deliverable}`;
          }
          if (this._job) {
            const fundTransfer = this._job.getFundTransferIntent();
            if (fundTransfer) {
              const resolved = await fundTransfer.resolveAmount(
                this.chainId,
                this.agent.getClient(this.chainId)
              );
              if (resolved) {
                line += ` | fund transfer: ${resolved.amount} ${resolved.symbol} to ${fundTransfer.recipientAddress}`;
              }
            }
          }
        }
        lines.push(line);
      } else {
        lines.push(`[${e.from}]  ${e.content}`);
      }
    }
    return lines.join("\n");
  }

  async toMessages(): Promise<
    { role: "system" | "user" | "assistant"; content: string }[]
  > {
    const result: {
      role: "system" | "user" | "assistant";
      content: string;
    }[] = [];
    for (const e of this.entries) {
      if (e.kind === "system") {
        const event = e.event;
        if (event.type === "budget.set") {
          const budget = AssetToken.usdc(
            Number(event.amount),
            this.chainId
          ).amount;
          let content = `The budget for this job is ${budget} USDC.`;
          if (this._job) {
            const fundRequest = this._job.getFundRequestIntent();
            if (fundRequest) {
              const resolved = await fundRequest.resolveAmount(
                this.chainId,
                this.agent.getClient(this.chainId)
              );
              if (resolved) {
                content += ` A fund transfer of ${resolved.amount} ${resolved.symbol} to ${fundRequest.recipientAddress} is requested.`;
              }
            }
          }
          result.push({ role: "system", content });
        } else if (event.type === "job.submitted") {
          let content = `The provider has submitted a deliverable: ${
            this._job?.deliverable ?? "(pending)"
          }`;
          if (this._job) {
            const fundTransfer = this._job.getFundTransferIntent();
            if (fundTransfer) {
              const resolved = await fundTransfer.resolveAmount(
                this.chainId,
                this.agent.getClient(this.chainId)
              );
              if (resolved) {
                content += ` A fund transfer of ${resolved.amount} ${resolved.symbol} to ${fundTransfer.recipientAddress} will be executed on completion.`;
              }
            }
          }
          result.push({ role: "system", content });
        } else {
          result.push({
            role: "system",
            content: `[${event.type}] ${JSON.stringify(event)}`,
          });
        }
      } else {
        const isOwnMessage = this.agentAddresses.has(e.from.toLowerCase());
        result.push({
          role: isOwnMessage ? "assistant" : "user",
          content: isOwnMessage ? e.content : `[${e.from}]: ${e.content}`,
        });
      }
    }
    return result;
  }
}
