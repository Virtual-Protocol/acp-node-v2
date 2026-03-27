import { encodeAbiParameters, type Address, type Hex } from "viem";
import {
  type AcpClient,
  type CreateAcpClientInput,
  createAcpClient,
} from "./clientFactory";
import { EvmAcpClient } from "./clients/evmAcpClient";
import type {
  CompleteParams,
  CreateJobParams,
  RejectParams,
  SubmitParams,
} from "./core/operations";
import {
  FUND_TRANSFER_HOOK_ADDRESSES,
  getAddressForChain,
} from "./core/constants";
import { AssetToken } from "./core/assetToken";
import { JobSession } from "./jobSession";
import { SocketTransport } from "./events/socketTransport";
import type {
  AcpTransport,
  AgentRole,
  JobRoomEntry,
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
  transport?: AcpTransport;
};

export type SetBudgetParams = {
  jobId: bigint;
  amount: AssetToken;
  optParams?: Hex;
};

export type FundJobParams = {
  jobId: bigint;
  amount: AssetToken;
};

export type SetBudgetWithFundRequestParams = {
  jobId: bigint;
  amount: AssetToken;
  transferAmount: AssetToken;
  destination: Address;
};

export type FundWithTransferParams = {
  jobId: bigint;
  amount: AssetToken;
  transferAmount: AssetToken;
  destination: Address;
  hookAddress?: string;
};

export type SubmitWithTransferParams = {
  jobId: bigint;
  deliverable: string;
  transferAmount: AssetToken;
  hookAddress?: string;
};

// ---------------------------------------------------------------------------
// AcpAgent
// ---------------------------------------------------------------------------

export class AcpAgent {
  private readonly client: AcpClient;
  private readonly transport: AcpTransport;
  private started = false;
  private entryHandler: EntryHandler | null = null;
  private sessions = new Map<string, JobSession>();
  private address: string | null = null;

  constructor(client: AcpClient, transport: AcpTransport) {
    this.client = client;
    this.transport = transport;
  }

  static async create(input: CreateAgentInput): Promise<AcpAgent> {
    const { transport = new SocketTransport(), ...clientInput } = input;
    const client = await createAcpClient(clientInput);
    return new AcpAgent(client, transport);
  }

  getClient(): AcpClient {
    return this.client;
  }

  getTransport(): AcpTransport {
    return this.transport;
  }

  getSupportedChainIds(): number[] {
    return this.client.getSupportedChainIds();
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

  private async buildTransportContext(): Promise<TransportContext> {
    if (!this.address) {
      this.address = await this.client.getAddress();
    }

    const providerChainIds =
      this.client instanceof EvmAcpClient
        ? await this.client.getProvider().getSupportedChainIds()
        : [];

    return {
      agentAddress: this.address,
      contractAddresses: this.client.getContractAddresses(),
      providerSupportedChainIds: providerChainIds,
      client: this.client,
      signMessage: (chainId: number, msg: string) => {
        if (this.client instanceof EvmAcpClient) {
          return this.client.getProvider().signMessage(chainId, msg);
        }
        throw new Error("signMessage is not supported for this provider");
      },
    };
  }

  async start(onConnected?: () => void): Promise<void> {
    if (this.started) {
      throw new Error("Agent already started. Call stop() first.");
    }

    this.started = true;
    const ctx = await this.buildTransportContext();

    this.transport.onEntry((entry) =>
      this.dispatch(entry).catch(console.error)
    );
    await this.transport.connect(ctx, onConnected);

    await this.hydrateSessions();
  }

  async stop(): Promise<void> {
    if (this.started) {
      await this.transport.disconnect();
      this.started = false;
    }
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Session hydration (on startup, catch up with existing rooms)
  // -------------------------------------------------------------------------

  private async hydrateSessions(): Promise<void> {
    if (!this.started) return;

    const jobs = await this.transport.getActiveJobs();

    for (const job of jobs) {
      const entries = await this.transport.getHistory(
        job.chainId,
        job.onChainJobId
      );
      const session = this.getOrCreateSession(
        job.onChainJobId,
        job.chainId,
        entries
      );
      await session.fetchJob();
      this.fireHandler(session, entries[entries.length - 1]!);
    }
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  private getSessionKey(chainId: number, jobId: string): string {
    return `${chainId}-${jobId}`;
  }

  getSession(chainId: number, jobId: string): JobSession | undefined {
    return this.sessions.get(this.getSessionKey(chainId, jobId));
  }

  private getOrCreateSession(
    jobId: string,
    chainId: number,
    initialEntries: JobRoomEntry[] = []
  ): JobSession {
    let session = this.sessions.get(this.getSessionKey(chainId, jobId));
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
    this.sessions.set(this.getSessionKey(chainId, jobId), session);
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

  private async dispatch(entry: JobRoomEntry): Promise<void> {
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
        this.sessions.set(this.getSessionKey(chainId, jobId), newSession);
        await newSession.fetchJob();
        this.fireHandler(newSession, entry);
        return;
      }
    }

    await session.fetchJob();
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
    if (!this.started) throw new Error("Agent not started");
    this.transport.sendMessage(chainId, jobId, content, contentType);
  }

  /**
   * One-shot message send via REST. Does not require start()/stop().
   * Authenticates, POSTs the message, and returns.
   */
  async sendMessage(
    chainId: number,
    jobId: string,
    content: string,
    contentType: string = "text"
  ): Promise<void> {
    const ctx = await this.buildTransportContext();
    await this.transport.postMessage(ctx, chainId, jobId, content, contentType);
  }

  // -------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------

  async resolveAssetToken(
    address: Address,
    amount: number,
    chainId: number
  ): Promise<AssetToken> {
    return AssetToken.fromOnChain(address, amount, chainId, this.client);
  }

  async resolveRawAssetToken(
    address: Address,
    rawAmount: bigint,
    chainId: number
  ): Promise<AssetToken> {
    return AssetToken.fromOnChainRaw(address, rawAmount, chainId, this.client);
  }

  // -------------------------------------------------------------------------
  // Job creation (on-chain, room is created by the observer)
  // -------------------------------------------------------------------------

  async createJob(chainId: number, params: CreateJobParams): Promise<bigint> {
    const prepared = await this.client.createJob(chainId, params);
    const result = await this.client.submitPrepared(chainId, [prepared]);
    const txHash = Array.isArray(result) ? result[0]! : result;

    console.log("txHash", txHash);

    const jobId = await this.client.getJobIdFromTxHash(chainId, txHash);
    if (!jobId) throw new Error("Failed to extract job ID from transaction");
    return jobId;
  }

  async createFundTransferJob(
    chainId: number,
    params: CreateJobParams
  ): Promise<bigint> {
    const defaultHook = getAddressForChain(
      FUND_TRANSFER_HOOK_ADDRESSES,
      chainId,
      "FundTransferHook"
    );
    return this.createJob(chainId, {
      ...params,
      hookAddress: params.hookAddress ?? defaultHook,
    });
  }

  // -------------------------------------------------------------------------
  // Internal on-chain actions (called by JobSession)
  // -------------------------------------------------------------------------

  /** @internal */
  async internalSetBudget(
    chainId: number,
    params: SetBudgetParams
  ): Promise<string | string[]> {
    const prepared = await this.client.setBudget(chainId, {
      jobId: params.jobId,
      amount: params.amount.rawAmount,
      optParams: params.optParams ?? "0x",
    });
    return this.client.submitPrepared(chainId, [prepared]);
  }

  /** @internal */
  async internalFund(
    chainId: number,
    params: FundJobParams
  ): Promise<string | string[]> {
    const approvePrepared = await this.client.approveAllowance(chainId, {
      tokenAddress: params.amount.address,
      spenderAddress: this.client.getContractAddress(chainId),
      amount: params.amount.rawAmount,
    });

    const fundPrepared = await this.client.fund(chainId, {
      jobId: params.jobId,
      expectedBudget: params.amount.rawAmount,
    });

    return this.client.submitPrepared(chainId, [approvePrepared, fundPrepared]);
  }

  /** @internal */
  async internalSubmit(
    chainId: number,
    params: SubmitParams
  ): Promise<string | string[]> {
    const prepared = await this.client.submit(chainId, params);
    return this.client.submitPrepared(chainId, [prepared]);
  }

  /** @internal */
  async internalComplete(
    chainId: number,
    params: CompleteParams
  ): Promise<string | string[]> {
    const prepared = await this.client.complete(chainId, params);
    return this.client.submitPrepared(chainId, [prepared]);
  }

  /** @internal */
  async internalReject(
    chainId: number,
    params: RejectParams
  ): Promise<string | string[]> {
    const prepared = await this.client.reject(chainId, params);
    return this.client.submitPrepared(chainId, [prepared]);
  }

  /** @internal */
  async internalSetBudgetWithFundRequest(
    chainId: number,
    params: SetBudgetWithFundRequestParams
  ): Promise<string | string[]> {
    const optParams = encodeAbiParameters(
      [
        { type: "address", name: "token" },
        { type: "uint256", name: "amount" },
        { type: "address", name: "destination" },
      ],
      [
        params.transferAmount.address as Address,
        params.transferAmount.rawAmount,
        params.destination as Address,
      ]
    );

    return this.internalSetBudget(chainId, {
      jobId: params.jobId,
      amount: params.amount,
      optParams,
    });
  }

  /** @internal */
  async internalFundWithTransfer(
    chainId: number,
    params: FundWithTransferParams
  ): Promise<string | string[]> {
    const approveAcp = await this.client.approveAllowance(chainId, {
      tokenAddress: params.amount.address,
      spenderAddress: this.client.getContractAddress(chainId),
      amount: params.amount.rawAmount,
    });

    const hookAddr =
      params.hookAddress ??
      getAddressForChain(
        FUND_TRANSFER_HOOK_ADDRESSES,
        chainId,
        "FundTransferHook"
      );
    const approveHook = await this.client.approveAllowance(chainId, {
      tokenAddress: params.transferAmount.address,
      spenderAddress: hookAddr,
      amount: params.transferAmount.rawAmount,
    });

    const optParams: Hex = encodeAbiParameters(
      [
        { type: "address", name: "expectedToken" },
        { type: "uint256", name: "expectedAmount" },
        { type: "address", name: "expectedRecipient" },
      ],
      [
        params.transferAmount.address,
        params.transferAmount.rawAmount,
        params.destination,
      ]
    );

    const fundPrepared = await this.client.fund(chainId, {
      jobId: params.jobId,
      expectedBudget: params.amount.rawAmount,
      optParams,
    });

    return this.client.submitPrepared(chainId, [
      approveAcp,
      approveHook,
      fundPrepared,
    ]);
  }

  /** @internal */
  async internalSubmitWithTransfer(
    chainId: number,
    params: SubmitWithTransferParams
  ): Promise<string | string[]> {
    const hookAddr =
      params.hookAddress ??
      getAddressForChain(
        FUND_TRANSFER_HOOK_ADDRESSES,
        chainId,
        "FundTransferHook"
      );
    const approvePrepared = await this.client.approveAllowance(chainId, {
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

    const submitPrepared = await this.client.submit(chainId, {
      jobId: params.jobId,
      deliverable: params.deliverable,
      optParams,
    });

    return this.client.submitPrepared(chainId, [
      approvePrepared,
      submitPrepared,
    ]);
  }
}
