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

  // private _job: AcpJob | null = null;
  private readonly agent: AcpAgent;
  private readonly agentAddress: string;

  constructor(
    agent: AcpAgent,
    agentAddress: string,
    jobId: string,
    chainId: number,
    roles: AgentRole[],
    initialEntries: JobRoomEntry[] = []
  ) {
    this.agent = agent;
    this.agentAddress = agentAddress.toLowerCase();
    this.jobId = jobId;
    this.chainId = chainId;
    this.roles = roles;
    this.entries.push(...initialEntries);
  }

  async fetchJob(): Promise<AcpJob | null> {
    try {
      const data = await this.agent
        .getClient()
        .getJob(this.chainId, BigInt(this.jobId));
      if (data) return new AcpJob(data);
    } catch {
      console.error(
        `Failed to fetch job ${this.jobId} on chain ${this.chainId}`
      );
    }
    return null;
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
      return entry.from.toLowerCase() !== this.agentAddress;
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
    });
  }

  async fund(amount: AssetToken): Promise<void> {
    await this.agent.internalFund(this.chainId, {
      jobId: BigInt(this.jobId),
      amount,
    });
  }

  async fundWithTransfer(
    amount: AssetToken,
    transferAmount: AssetToken,
    destination: Address
  ): Promise<void> {
    await this.agent.internalFundWithTransfer(this.chainId, {
      jobId: BigInt(this.jobId),
      amount,
      transferAmount,
      destination,
    });
  }

  async submit(deliverable: string): Promise<void> {
    await this.agent.internalSubmit(this.chainId, {
      jobId: BigInt(this.jobId),
      deliverable,
    });
  }

  async complete(reason: string): Promise<void> {
    await this.agent.internalComplete(this.chainId, {
      jobId: BigInt(this.jobId),
      reason,
    });
  }

  async reject(reason: string): Promise<void> {
    await this.agent.internalReject(this.chainId, {
      jobId: BigInt(this.jobId),
      reason,
    });
  }

  // -------------------------------------------------------------------------
  // Context serialization
  // -------------------------------------------------------------------------

  toContext(): string {
    return this.entries
      .map((e) => {
        if (e.kind === "system") {
          return `[system]  ${e.event.type} — ${JSON.stringify(e.event)}`;
        }
        return `[${e.from}]  ${e.content}`;
      })
      .join("\n");
  }

  toMessages(): { role: "system" | "user" | "assistant"; content: string }[] {
    return this.entries.map((e) => {
      if (e.kind === "system") {
        const event = e.event;

        if (event.type === "budget.set") {
          return {
            role: "system" as const,
            content: `The budget for this job is ${
              AssetToken.usdcFromRaw(BigInt(event.amount), this.chainId).amount
            } USDC.`,
          };
        }

        return {
          role: "system" as const,
          content: `[${event.type}] ${JSON.stringify(event)}`,
        };
      }
      const isOwnMessage = e.from.toLowerCase() === this.agentAddress;
      return {
        role: isOwnMessage ? ("assistant" as const) : ("user" as const),
        content: isOwnMessage ? e.content : `[${e.from}]: ${e.content}`,
      };
    });
  }
}
