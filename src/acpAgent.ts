import { encodeAbiParameters, type Address, type Hex } from "viem";
import {
  type AcpClient,
  type CreateAcpClientInput,
  createAcpClient,
} from "./clientFactory";
import { EvmAcpClient } from "./clients/evmAcpClient";
import { SolanaAcpClient } from "./clients/solanaAcpClient";
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
import { AcpApiClient } from "./events/acpApiClient";
import { AcpHttpClient } from "./events/acpHttpClient";
import type {
  AcpChatTransport,
  AcpJobApi,
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
  transport?: AcpChatTransport;
  api?: AcpJobApi;
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
  private readonly transport: AcpChatTransport;
  private readonly api: AcpJobApi;
  private started = false;
  private entryHandler: EntryHandler | null = null;
  private sessions = new Map<string, JobSession>();
  private address: string | null = null;

  constructor(client: AcpClient, transport: AcpChatTransport, api: AcpJobApi) {
    this.client = client;
    this.transport = transport;
    this.api = api;
  }

  static async create(input: CreateAgentInput): Promise<AcpAgent> {
    const {
      transport = new SocketTransport(),
      api = new AcpApiClient(),
      ...clientInput
    } = input;
    const client = await createAcpClient(clientInput);
    const agent = new AcpAgent(client, transport, api);

    const ctx = await agent.buildTransportContext();
    if (transport instanceof AcpHttpClient) transport.setContext(ctx);
    if (api instanceof AcpHttpClient) api.setContext(ctx);

    return agent;
  }

  getClient(): AcpClient {
    return this.client;
  }

  getTransport(): AcpChatTransport {
    return this.transport;
  }

  getApi(): AcpJobApi {
    return this.api;
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
        : this.client.getSupportedChainIds();

    return {
      agentAddress: this.address,
      contractAddresses: this.client.getContractAddresses(),
      providerSupportedChainIds: providerChainIds,
      client: this.client,
      signMessage: async (chainId: number, msg: string) => {
        if (this.client instanceof EvmAcpClient) {
          return this.client.getProvider().signMessage(chainId, msg);
        }
        if (this.client instanceof SolanaAcpClient) {
          const { createSignableMessage } = await import("@solana/kit");
          const signer = this.client.getProvider().getSigner();
          const signable = createSignableMessage(msg);
          const [signatures] = await signer.signMessages([signable]);
          const sigBytes = signatures![signer.address];
          if (!sigBytes) throw new Error("Solana message signing failed");
          // Encode as base58 for the backend
          const { getBase58Decoder } = await import("@solana/kit");
          return getBase58Decoder().decode(sigBytes);
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

    this.transport.onEntry((entry) =>
      this.dispatch(entry).catch(console.error)
    );
    await this.transport.connect(onConnected);

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

    const jobs = await this.api.getActiveJobs();

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
    await this.transport.postMessage(chainId, jobId, content, contentType);
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
    const prepared = [];

    if (this.client.getCapabilities().supportsAllowance) {
      prepared.push(
        await this.client.approveAllowance(chainId, {
          tokenAddress: params.amount.address,
          spenderAddress: this.client.getContractAddress(chainId),
          amount: params.amount.rawAmount,
        })
      );
    }

    prepared.push(
      await this.client.fund(chainId, {
        jobId: params.jobId,
        expectedBudget: params.amount.rawAmount,
      })
    );

    return this.client.submitPrepared(chainId, prepared);
  }

  /** @internal */
  async internalSubmit(
    chainId: number,
    params: SubmitParams
  ): Promise<string | string[]> {
    await this.api.postDeliverable(
      chainId,
      params.jobId.toString(),
      params.deliverable
    );
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
    const prepared = [];

    if (this.client.getCapabilities().supportsAllowance) {
      prepared.push(
        await this.client.approveAllowance(chainId, {
          tokenAddress: params.amount.address,
          spenderAddress: this.client.getContractAddress(chainId),
          amount: params.amount.rawAmount,
        })
      );

      const hookAddr =
        params.hookAddress ??
        getAddressForChain(
          FUND_TRANSFER_HOOK_ADDRESSES,
          chainId,
          "FundTransferHook"
        );
      prepared.push(
        await this.client.approveAllowance(chainId, {
          tokenAddress: params.transferAmount.address,
          spenderAddress: hookAddr,
          amount: params.transferAmount.rawAmount,
        })
      );
    }

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

    prepared.push(
      await this.client.fund(chainId, {
        jobId: params.jobId,
        expectedBudget: params.amount.rawAmount,
        optParams,
      })
    );

    return this.client.submitPrepared(chainId, prepared);
  }

  /** @internal */
  async internalSubmitWithTransfer(
    chainId: number,
    params: SubmitWithTransferParams
  ): Promise<string | string[]> {
    await this.api.postDeliverable(
      chainId,
      params.jobId.toString(),
      params.deliverable
    );

    const prepared = [];

    if (this.client.getCapabilities().supportsAllowance) {
      const hookAddr =
        params.hookAddress ??
        getAddressForChain(
          FUND_TRANSFER_HOOK_ADDRESSES,
          chainId,
          "FundTransferHook"
        );
      prepared.push(
        await this.client.approveAllowance(chainId, {
          tokenAddress: params.transferAmount.address,
          spenderAddress: hookAddr,
          amount: params.transferAmount.rawAmount,
        })
      );
    }

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

    prepared.push(
      await this.client.submit(chainId, {
        jobId: params.jobId,
        deliverable: params.deliverable,
        optParams,
      })
    );

    return this.client.submitPrepared(chainId, prepared);
  }
}
