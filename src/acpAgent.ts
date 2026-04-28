import { encodeAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import Ajv from "ajv";
import {
  type AcpClient,
  type CreateAcpClientInput,
  createAcpClients,
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
  MIN_SLA_MINS,
  BUFFER_SECONDS,
  type ChainFamily,
  getChainFamily,
} from "./core/constants";
import { AssetToken } from "./core/assetToken";
import { JobSession } from "./jobSession";
import { AcpApiClient } from "./events/acpApiClient";
import { AcpHttpClient } from "./events/acpHttpClient";
import type {
  AcpAgentDetail,
  AcpAgentOffering,
  AcpChatTransport,
  AcpJobApi,
  AgentRole,
  BrowseAgentParams,
  JobRoomEntry,
  TransportContext,
} from "./events/types";
import { SseTransport } from "./events/sseTransport";

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
  clientAddress?: string;
  optParams?: Hex;
};

export type FundJobParams = {
  jobId: bigint;
  amount: AssetToken;
  clientAddress?: string;
};

export type SetBudgetWithFundRequestParams = {
  jobId: bigint;
  amount: AssetToken;
  transferAmount: AssetToken;
  destination: Address;
  clientAddress?: string;
};

export type FundWithTransferParams = {
  jobId: bigint;
  amount: AssetToken;
  transferAmount: AssetToken;
  destination: Address;
  clientAddress?: string;
  hookAddress?: string;
};

export type SubmitWithTransferParams = {
  jobId: bigint;
  deliverable: string;
  transferAmount: AssetToken;
  clientAddress?: string;
  hookAddress?: string;
};

// ---------------------------------------------------------------------------
// AcpAgent
// ---------------------------------------------------------------------------

export class AcpAgent {
  private readonly clients: Map<ChainFamily, AcpClient>;
  private readonly transport: AcpChatTransport;
  private readonly api: AcpJobApi;
  private started = false;
  private entryHandler: EntryHandler | null = null;
  private sessions = new Map<string, JobSession>();
  private addresses = new Map<ChainFamily, string>();

  constructor(
    clients: Map<ChainFamily, AcpClient>,
    transport: AcpChatTransport,
    api: AcpJobApi
  ) {
    this.clients = clients;
    this.transport = transport;
    this.api = api;
  }

  static async create(input: CreateAgentInput): Promise<AcpAgent> {
    const {
      transport = new SseTransport(),
      api = new AcpApiClient(),
      ...clientInput
    } = input;
    const clients = await createAcpClients(clientInput);
    const agent = new AcpAgent(clients, transport, api);

    const ctx = await agent.buildTransportContext();
    if (transport instanceof AcpHttpClient) transport.setContext(ctx);
    if (api instanceof AcpHttpClient) api.setContext(ctx);

    return agent;
  }

  // -------------------------------------------------------------------------
  // Client routing
  // -------------------------------------------------------------------------

  getClient(chainId: number): AcpClient {
    const family = getChainFamily(chainId);
    const client = this.clients.get(family);
    if (!client) {
      throw new Error(`No ${family} client configured for chainId ${chainId}`);
    }
    return client;
  }

  getTransport(): AcpChatTransport {
    return this.transport;
  }

  getApi(): AcpJobApi {
    return this.api;
  }

  getSupportedChainIds(): number[] {
    const ids: number[] = [];
    for (const client of this.clients.values()) {
      ids.push(...client.getSupportedChainIds());
    }
    return ids;
  }

  async browseAgents(
    keyword: string,
    params?: BrowseAgentParams
  ): Promise<Array<AcpAgentDetail>> {
    const chainIds = this.getSupportedChainIds();
    const walletAddress = [...this.addresses.values()][0] ?? "";
    const queryParams = {
      ...params,
      walletAddressToExclude: walletAddress,
    };
    return await this.api.browseAgents(keyword, chainIds, queryParams);
  }

  async getAgentByWalletAddress(
    walletAddress: string
  ): Promise<AcpAgentDetail | null> {
    return this.api.getAgentByWalletAddress(walletAddress);
  }

  async getAddress(family: ChainFamily): Promise<string> {
    if (!this.addresses.has(family)) {
      const client = this.clients.get(family);
      if (!client) {
        throw new Error(`No ${family} client configured for ${family} family`);
      }
      this.addresses.set(family, await client.getAddress());
    }
    return this.addresses.get(family)!;
  }

  getAllAddresses(): string[] {
    return [...this.addresses.values()];
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
    for (const [family, client] of this.clients) {
      if (!this.addresses.has(family)) {
        this.addresses.set(family, await client.getAddress());
      }
    }

    const allContractAddresses: Record<number, string> = {};
    for (const client of this.clients.values()) {
      Object.assign(allContractAddresses, client.getContractAddresses());
    }

    const providerChainIds: number[] = [];
    for (const [, client] of this.clients) {
      if (client instanceof EvmAcpClient) {
        providerChainIds.push(
          ...(await client.getProvider().getSupportedChainIds())
        );
      } else {
        providerChainIds.push(...client.getSupportedChainIds());
      }
    }

    return {
      agentAddresses: Object.fromEntries(this.addresses),
      contractAddresses: allContractAddresses,
      providerSupportedChainIds: providerChainIds,
      getClientForChain: (chainId: number) => this.getClient(chainId),
      signMessage: async (chainId: number, msg: string) => {
        const family = getChainFamily(chainId);
        const client = this.clients.get(family);
        if (!client) {
          throw new Error(
            `No ${family} client for signing on chainId ${chainId}`
          );
        }

        if (client instanceof EvmAcpClient) {
          return client.getProvider().signMessage(chainId, msg);
        }
        if (client instanceof SolanaAcpClient) {
          const { createSignableMessage, getBase58Decoder } =
            await import("@solana/kit");
          const signer = client.getProvider().getSigner();
          const signable = createSignableMessage(msg);
          const [signatures] = await signer.signMessages([signable]);
          const sigBytes = signatures![signer.address];
          if (!sigBytes) throw new Error("Solana message signing failed");
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
      if (entries.length === 0) continue;
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
      [...this.addresses.values()],
      jobId,
      chainId,
      roles,
      initialEntries
    );
    this.sessions.set(this.getSessionKey(chainId, jobId), session);
    return session;
  }

  private inferRoles(entries: JobRoomEntry[]): AgentRole[] {
    const myAddresses = new Set(
      [...this.addresses.values()].map((a) => a.toLowerCase())
    );

    for (const entry of entries) {
      if (entry.kind === "system" && entry.event.type === "job.created") {
        const event = entry.event as Record<string, unknown>;
        const roles: AgentRole[] = [];
        if (myAddresses.has((event.client as string)?.toLowerCase()))
          roles.push("client");
        if (myAddresses.has((event.provider as string)?.toLowerCase()))
          roles.push("provider");
        if (myAddresses.has((event.evaluator as string)?.toLowerCase()))
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
          [...this.addresses.values()],
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
    return AssetToken.fromOnChain(
      address,
      amount,
      chainId,
      this.getClient(chainId)
    );
  }

  async resolveRawAssetToken(
    address: Address,
    rawAmount: bigint,
    chainId: number
  ): Promise<AssetToken> {
    return AssetToken.fromOnChainRaw(
      address,
      rawAmount,
      chainId,
      this.getClient(chainId)
    );
  }

  // -------------------------------------------------------------------------
  // Job creation (on-chain, room is created by the observer)
  // -------------------------------------------------------------------------

  async createJob(chainId: number, params: CreateJobParams): Promise<bigint> {
    const client = this.getClient(chainId);
    const prepared = await client.createJob(chainId, params);
    const result = await client.submitPrepared(chainId, [prepared]);
    const txHash = Array.isArray(result) ? result[0]! : result;

    const jobId = await client.getJobIdFromTxHash(chainId, txHash);
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

  async createJobFromOffering(
    chainId: number,
    offering: AcpAgentOffering,
    providerAddress: string,
    requirementData: Record<string, unknown> | string,
    opts?: {
      evaluatorAddress?: string;
      hookAddress?: string;
    }
  ): Promise<bigint> {
    if (
      offering.requirements &&
      typeof offering.requirements === "object" &&
      typeof requirementData === "object"
    ) {
      const ajv = new Ajv({ allErrors: true });
      const validate = ajv.compile(offering.requirements);
      if (!validate(requirementData)) {
        throw new Error(
          `Requirement validation failed: ${ajv.errorsText(validate.errors)}`
        );
      }
    }

    const buffer = offering.slaMinutes === MIN_SLA_MINS ? BUFFER_SECONDS : 0;
    const expiredAt =
      Math.floor(Date.now() / 1000) + offering.slaMinutes * 60 + buffer;

    const jobParams: CreateJobParams = {
      providerAddress,
      evaluatorAddress: opts?.evaluatorAddress ?? zeroAddress,
      expiredAt,
      description: offering.name,
      ...(opts?.hookAddress ? { hookAddress: opts.hookAddress } : {}),
    };

    const jobId = offering.requiredFunds
      ? await this.createFundTransferJob(chainId, jobParams)
      : await this.createJob(chainId, jobParams);

    const maxRetries = 5;
    const retryDelayMs = 2000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.sendMessage(
          chainId,
          jobId.toString(),
          JSON.stringify(requirementData),
          "requirement"
        );
        break;
      } catch (err) {
        if (attempt === maxRetries) throw err;
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }

    return jobId;
  }

  async createJobByOfferingName(
    chainId: number,
    offeringName: string,
    providerAddress: string,
    requirementData: Record<string, unknown> | string,
    opts?: {
      evaluatorAddress?: string;
      hookAddress?: string;
    }
  ): Promise<bigint> {
    const agent = await this.api.getAgentByWalletAddress(providerAddress);
    if (!agent) {
      throw new Error(`No agent found for wallet address: ${providerAddress}`);
    }

    const matchingOfferings = agent.offerings.filter(
      (o) => o.name === offeringName
    );

    if (matchingOfferings.length === 0) {
      const available = agent.offerings.map((o) => o.name).join(", ");
      throw new Error(
        `Offering "${offeringName}" not found. Available offerings: ${
          available || "none"
        }`
      );
    }

    if (matchingOfferings.length > 1) {
      throw new Error(
        `Multiple offerings named "${offeringName}" found. Use createJobFromOffering with the full offering object instead.`
      );
    }

    return this.createJobFromOffering(
      chainId,
      matchingOfferings[0]!,
      providerAddress,
      requirementData,
      opts
    );
  }

  // -------------------------------------------------------------------------
  // Internal on-chain actions (called by JobSession)
  // -------------------------------------------------------------------------

  /** @internal */
  async internalSetBudget(
    chainId: number,
    params: SetBudgetParams
  ): Promise<string | string[]> {
    const client = this.getClient(chainId);
    const prepared = await client.setBudget(chainId, {
      jobId: params.jobId,
      amount: params.amount.rawAmount,
      ...(params.clientAddress && { clientAddress: params.clientAddress }),
      optParams: params.optParams ?? "0x",
    });
    return client.submitPrepared(chainId, [prepared]);
  }

  /** @internal */
  async internalFund(
    chainId: number,
    params: FundJobParams
  ): Promise<string | string[]> {
    const client = this.getClient(chainId);
    const prepared = [];

    if (client.getCapabilities().supportsAllowance) {
      prepared.push(
        await client.approveAllowance(chainId, {
          tokenAddress: params.amount.address,
          spenderAddress: client.getContractAddress(chainId),
          amount: params.amount.rawAmount,
        })
      );
    }

    prepared.push(
      await client.fund(chainId, {
        jobId: params.jobId,
        expectedBudget: params.amount.rawAmount,
        ...(params.clientAddress && { clientAddress: params.clientAddress }),
      })
    );

    return client.submitPrepared(chainId, prepared);
  }

  /** @internal */
  async internalSubmit(
    chainId: number,
    params: SubmitParams
  ): Promise<string | string[]> {
    const client = this.getClient(chainId);
    await this.api.postDeliverable(
      chainId,
      params.jobId.toString(),
      params.deliverable
    );
    const prepared = await client.submit(chainId, params);
    return client.submitPrepared(chainId, [prepared]);
  }

  /** @internal */
  async internalComplete(
    chainId: number,
    params: CompleteParams
  ): Promise<string | string[]> {
    const client = this.getClient(chainId);
    const prepared = await client.complete(chainId, params);
    return client.submitPrepared(chainId, [prepared]);
  }

  /** @internal */
  async internalReject(
    chainId: number,
    params: RejectParams
  ): Promise<string | string[]> {
    const client = this.getClient(chainId);
    const prepared = await client.reject(chainId, params);
    return client.submitPrepared(chainId, [prepared]);
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
      ...(params.clientAddress && { clientAddress: params.clientAddress }),
      optParams,
    });
  }

  /** @internal */
  async internalFundWithTransfer(
    chainId: number,
    params: FundWithTransferParams
  ): Promise<string | string[]> {
    const client = this.getClient(chainId);
    const prepared = [];

    if (client.getCapabilities().supportsAllowance) {
      prepared.push(
        await client.approveAllowance(chainId, {
          tokenAddress: params.amount.address,
          spenderAddress: client.getContractAddress(chainId),
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
        await client.approveAllowance(chainId, {
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
      await client.fund(chainId, {
        jobId: params.jobId,
        expectedBudget: params.amount.rawAmount,
        ...(params.clientAddress && { clientAddress: params.clientAddress }),
        optParams,
      })
    );

    return client.submitPrepared(chainId, prepared);
  }

  /** @internal */
  async internalSubmitWithTransfer(
    chainId: number,
    params: SubmitWithTransferParams
  ): Promise<string | string[]> {
    const client = this.getClient(chainId);
    await this.api.postDeliverable(
      chainId,
      params.jobId.toString(),
      params.deliverable
    );

    const prepared = [];

    if (client.getCapabilities().supportsAllowance) {
      const hookAddr =
        params.hookAddress ??
        getAddressForChain(
          FUND_TRANSFER_HOOK_ADDRESSES,
          chainId,
          "FundTransferHook"
        );
      prepared.push(
        await client.approveAllowance(chainId, {
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
      await client.submit(chainId, {
        jobId: params.jobId,
        deliverable: params.deliverable,
        ...(params.clientAddress && { clientAddress: params.clientAddress }),
        optParams,
      })
    );

    return client.submitPrepared(chainId, prepared);
  }
}
