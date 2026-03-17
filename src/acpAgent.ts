import { encodeAbiParameters, type Address, type Hex } from "viem";
import {
  type AcpClient,
  type CreateAcpClientInput,
  createAcpClient,
} from "./clientFactory";
import type {
  CompleteParams,
  CreateJobParams,
  RejectParams,
  SubmitParams,
} from "./core/operations";
import { FUND_TRANSFER_HOOK_ADDRESS } from "./core/constants";
import { Erc20Token } from "./core/erc20Token";
import { JobSession } from "./jobSession";
import { SocketTransport } from "./events/socketTransport";
import type {
  AcpTransport,
  AgentRole,
  JobRoomEntry,
  TransportConfig,
  TransportContext,
} from "./events/types";

export type EntryHandler = (
  session: JobSession,
  entry: JobRoomEntry
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Public param types
// ---------------------------------------------------------------------------

export type CreateAgentInput = CreateAcpClientInput & {
  transport: TransportConfig;
};

export type SetBudgetParams = {
  jobId: bigint;
  amount: Erc20Token;
  optParams?: Hex;
};

export type FundJobParams = {
  jobId: bigint;
  amount: Erc20Token;
};

export type SetFundTransferBudgetParams = {
  jobId: bigint;
  amount: Erc20Token;
  transferAmount: Erc20Token;
  destination: string;
  subExpiry?: bigint;
  packageId?: bigint;
};

export type FundWithTransferParams = {
  jobId: bigint;
  amount: Erc20Token;
  transferAmount: Erc20Token;
  targetIntentId: bigint;
  hookAddress?: string;
};

export type SubmitWithTransferParams = {
  jobId: bigint;
  deliverable: string;
  transferAmount: Erc20Token;
  hookAddress?: string;
};

// ---------------------------------------------------------------------------
// AcpAgent
// ---------------------------------------------------------------------------

export class AcpAgent {
  private readonly client: AcpClient;
  private readonly transportConfig: TransportConfig;
  private transport: AcpTransport | null = null;
  private entryHandler: EntryHandler | null = null;
  private sessions = new Map<string, JobSession>();
  private address: string | null = null;

  constructor(client: AcpClient, transportConfig: TransportConfig) {
    this.client = client;
    this.transportConfig = transportConfig;
  }

  static async create(input: CreateAgentInput): Promise<AcpAgent> {
    const { transport, ...clientInput } = input;
    const client = await createAcpClient(clientInput);
    return new AcpAgent(client, transport);
  }

  getClient(): AcpClient {
    return this.client;
  }

  async getAddress(): Promise<string> {
    if (!this.address) {
      this.address = await this.client.getAddress();
    }
    return this.address;
  }

  // -------------------------------------------------------------------------
  // Single entry handler
  // -------------------------------------------------------------------------

  on(_event: "entry", handler: EntryHandler): this {
    this.entryHandler = handler;
    return this;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.transport) {
      throw new Error("Agent already started. Call stop() first.");
    }

    const transport = this.buildTransport();
    this.transport = transport;
    this.address = await this.client.getAddress();

    const ctx: TransportContext = {
      agentAddress: this.address,
      contractAddress: this.client.getContractAddress(),
      client: this.client,
    };

    transport.onEntry((entry) => this.dispatch(entry));
    await transport.connect(ctx);

    await this.hydrateSessions();
  }

  async stop(): Promise<void> {
    if (this.transport) {
      await this.transport.disconnect();
      this.transport = null;
    }
    this.sessions.clear();
  }

  private buildTransport(): AcpTransport {
    const cfg = this.transportConfig;
    return new SocketTransport({ serverUrl: cfg.url });
  }

  // -------------------------------------------------------------------------
  // Session hydration (on startup, catch up with existing rooms)
  // -------------------------------------------------------------------------

  private async hydrateSessions(): Promise<void> {
    if (!this.transport) return;

    const jobs = await this.transport.getActiveJobs();

    for (const job of jobs) {
      const entries = await this.transport.getHistory(
        job.chainId,
        job.onChainJobId
      );
      this.getOrCreateSession(job.onChainJobId, job.chainId, entries);
    }
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  getSession(jobId: string): JobSession | undefined {
    return this.sessions.get(jobId);
  }

  private getOrCreateSession(
    jobId: string,
    chainId: number,
    initialEntries: JobRoomEntry[] = []
  ): JobSession {
    let session = this.sessions.get(jobId);
    if (session) return session;

    const roles = this.inferRoles(initialEntries);
    session = new JobSession(
      this,
      this.address!,
      jobId,
      chainId,
      roles,
      initialEntries
    );
    this.sessions.set(jobId, session);
    return session;
  }

  private inferRoles(entries: JobRoomEntry[]): AgentRole[] {
    const addr = this.address!.toLowerCase();

    for (const entry of entries) {
      if (entry.kind === "system" && entry.event.type === "job.created") {
        const event = entry.event as Record<string, unknown>;
        const roles: AgentRole[] = [];
        if ((event.client as string)?.toLowerCase() === addr)
          roles.push("client");
        if ((event.provider as string)?.toLowerCase() === addr)
          roles.push("provider");
        if ((event.evaluator as string)?.toLowerCase() === addr)
          roles.push("evaluator");
        if (roles.length > 0) return roles;
      }
    }

    return ["provider"];
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private dispatch(entry: JobRoomEntry): void {
    const jobId = entry.onChainJobId;
    const chainId = entry.chainId;
    const session = this.getOrCreateSession(jobId, chainId, []);

    if (session.entries.length === 0 || !session.entries.includes(entry)) {
      session.appendEntry(entry);
    }

    if (entry.kind === "system" && entry.event.type === "job.created") {
      const roles = this.inferRoles([entry]);
      const rolesChanged =
        roles.length !== session.roles.length ||
        roles.some((r, i) => r !== session.roles[i]);
      if (rolesChanged) {
        const newSession = new JobSession(
          this,
          this.address!,
          jobId,
          chainId,
          roles,
          session.entries
        );
        this.sessions.set(jobId, newSession);
        this.fireHandler(newSession, entry);
        return;
      }
    }

    this.fireHandler(session, entry);
  }

  private fireHandler(session: JobSession, entry: JobRoomEntry): void {
    if (!this.entryHandler) return;
    if (!session.shouldRespond(entry)) return;

    try {
      const result = this.entryHandler(session, entry);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => {
          console.error(`[AcpAgent] entry handler error:`, err);
        });
      }
    } catch (err) {
      console.error(`[AcpAgent] entry handler error:`, err);
    }
  }

  // -------------------------------------------------------------------------
  // Messaging (delegates to transport)
  // -------------------------------------------------------------------------

  sendJobMessage(
    chainId: number,
    jobId: string,
    content: string,
    contentType: string = "text"
  ): void {
    if (!this.transport) throw new Error("Agent not started");
    this.transport.sendMessage(chainId, jobId, content, contentType);
  }

  // -------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------

  async resolveToken(address: string, amount: number): Promise<Erc20Token> {
    return Erc20Token.fromOnChain(address, amount, this.client);
  }

  // -------------------------------------------------------------------------
  // Job creation (on-chain, room is created by the observer)
  // -------------------------------------------------------------------------

  async createJob(params: CreateJobParams): Promise<bigint> {
    const prepared = await this.client.createJob(params);
    const result = await this.client.submitPrepared([prepared]);
    const txHash = Array.isArray(result) ? result[0]! : result;

    console.log("txHash", txHash);

    const jobId = await this.client.getJobIdFromTxHash(txHash);
    if (!jobId) throw new Error("Failed to extract job ID from transaction");
    return jobId;
  }

  async createFundTransferJob(params: CreateJobParams): Promise<bigint> {
    return this.createJob({
      ...params,
      hookAddress: params.hookAddress ?? FUND_TRANSFER_HOOK_ADDRESS,
    });
  }

  // -------------------------------------------------------------------------
  // Internal on-chain actions (called by JobSession)
  // -------------------------------------------------------------------------

  /** @internal */
  async internalSetBudget(params: SetBudgetParams): Promise<string | string[]> {
    const prepared = await this.client.setBudget({
      jobId: params.jobId,
      amount: params.amount.rawAmount,
      optParams: params.optParams ?? "0x",
    });
    return this.client.submitPrepared([prepared]);
  }

  /** @internal */
  async internalFund(params: FundJobParams): Promise<string | string[]> {
    const approvePrepared = await this.client.approveAllowance({
      tokenAddress: params.amount.address,
      spenderAddress: this.client.getContractAddress(),
      amount: params.amount.rawAmount,
    });

    const fundPrepared = await this.client.fund({
      jobId: params.jobId,
    });

    return this.client.submitPrepared([approvePrepared, fundPrepared]);
  }

  /** @internal */
  async internalSubmit(params: SubmitParams): Promise<string | string[]> {
    const prepared = await this.client.submit(params);
    return this.client.submitPrepared([prepared]);
  }

  /** @internal */
  async internalComplete(params: CompleteParams): Promise<string | string[]> {
    const prepared = await this.client.complete(params);
    return this.client.submitPrepared([prepared]);
  }

  /** @internal */
  async internalReject(params: RejectParams): Promise<string | string[]> {
    const prepared = await this.client.reject(params);
    return this.client.submitPrepared([prepared]);
  }

  /** @internal */
  async internalSetFundTransferBudget(
    params: SetFundTransferBudgetParams
  ): Promise<string | string[]> {
    const optParams = encodeAbiParameters(
      [
        { type: "address", name: "token" },
        { type: "uint256", name: "amount" },
        { type: "address", name: "destination" },
        { type: "uint256", name: "subExpiry" },
        { type: "uint256", name: "packageId" },
      ],
      [
        params.transferAmount.address as Address,
        params.transferAmount.rawAmount,
        params.destination as Address,
        params.subExpiry ?? 0n,
        params.packageId ?? 0n,
      ]
    );

    return this.internalSetBudget({
      jobId: params.jobId,
      amount: params.amount,
      optParams,
    });
  }

  /** @internal */
  async internalFundWithTransfer(
    params: FundWithTransferParams
  ): Promise<string | string[]> {
    const approveAcp = await this.client.approveAllowance({
      tokenAddress: params.amount.address,
      spenderAddress: this.client.getContractAddress(),
      amount: params.amount.rawAmount,
    });

    const hookAddr = params.hookAddress ?? FUND_TRANSFER_HOOK_ADDRESS;
    const approveHook = await this.client.approveAllowance({
      tokenAddress: params.transferAmount.address,
      spenderAddress: hookAddr,
      amount: params.transferAmount.rawAmount,
    });

    const optParams: Hex = encodeAbiParameters(
      [{ type: "uint256", name: "targetIntentId" }],
      [params.targetIntentId]
    );

    const fundPrepared = await this.client.fund({
      jobId: params.jobId,
      optParams,
    });

    return this.client.submitPrepared([approveAcp, approveHook, fundPrepared]);
  }

  /** @internal */
  async internalSubmitWithTransfer(
    params: SubmitWithTransferParams
  ): Promise<string | string[]> {
    const hookAddr = params.hookAddress ?? FUND_TRANSFER_HOOK_ADDRESS;
    const approvePrepared = await this.client.approveAllowance({
      tokenAddress: params.transferAmount.address,
      spenderAddress: hookAddr,
      amount: params.transferAmount.rawAmount,
    });

    const optParams: Hex = encodeAbiParameters(
      [
        { type: "address", name: "token" },
        { type: "uint256", name: "amount" },
      ],
      [
        params.transferAmount.address as Address,
        params.transferAmount.rawAmount,
      ]
    );

    const submitPrepared = await this.client.submit({
      jobId: params.jobId,
      deliverable: params.deliverable,
      optParams,
    });

    return this.client.submitPrepared([approvePrepared, submitPrepared]);
  }
}
