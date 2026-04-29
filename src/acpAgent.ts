import { encodeAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import Ajv from "ajv";
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
  MULTI_HOOK_ROUTER_ADDRESSES,
  SUBSCRIPTION_HOOK_ADDRESSES,
  SUBSCRIPTION_STATE_ADDRESSES,
  getAddressForChain,
  MIN_SLA_MINS,
  BUFFER_SECONDS,
} from "./core/constants";
import { SUBSCRIPTION_STATE_ABI } from "./core/subscriptionStateAbi";
import { SUBSCRIPTION_HOOK_ABI } from "./core/subscriptionHookAbi";
import { MULTI_HOOK_ROUTER_ABI } from "./core/multiHookRouterAbi";
import {
  buildSubscriptionWithFundsHookConfig,
  encodeFundTransferOptParams,
  encodeRouterOptParams,
  encodeSubscriptionOptParams,
  type MultiHookConfig,
} from "./core/hookEncoding";
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

export type SetBudgetWithSubscriptionParams = {
  jobId: bigint;
  amount: AssetToken;
  duration: bigint;
  packageId: bigint;
};

export type FundWithSubscriptionParams = {
  jobId: bigint;
  amount: AssetToken;
  duration: bigint;
  packageId: bigint;
};

export type SetBudgetWithSubscriptionAndFundRequestParams = {
  jobId: bigint;
  amount: AssetToken;
  duration: bigint;
  packageId: bigint;
  transferAmount: AssetToken;
  destination: Address;
};

export type FundViaRouterParams = {
  jobId: bigint;
  amount: AssetToken;
  hookConfigs: string[];
  subscriptionTerms?: { duration: bigint; packageId: bigint };
  transferAmount?: AssetToken;
  destination?: Address;
  fundHookAddress?: string;
};

export type BatchConfigureHooksAgentParams = {
  jobId: bigint;
  selectors: Hex[];
  hooksPerSelector: string[][];
  routerAddress: string;
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
      transport = new SseTransport(),
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

  async browseAgents(
    keyword: string,
    params?: BrowseAgentParams
  ): Promise<Array<AcpAgentDetail>> {
    const chainIds = this.client.getSupportedChainIds();
    const queryParams = {
      ...params,
      walletAddressToExclude: this.address ?? "",
    };
    return await this.api.browseAgents(keyword, chainIds, queryParams);
  }

  async getAgentByWalletAddress(
    walletAddress: string
  ): Promise<AcpAgentDetail | null> {
    return this.api.getAgentByWalletAddress(walletAddress);
  }

  async getMe(): Promise<AcpAgentDetail> {
    const address = await this.getAddress();
    const agent = await this.api.getAgentByWalletAddress(address);
    if (!agent) {
      throw new Error(`No agent found for wallet address: ${address}`);
    }
    return agent;
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
    contentType: string = "text",
    packageId?: number
  ): void {
    if (!this.started) throw new Error("Agent not started");
    this.transport.sendMessage(chainId, jobId, content, contentType, packageId);
  }

  /**
   * One-shot message send via REST. Does not require start()/stop().
   * Authenticates, POSTs the message, and returns.
   */
  async sendMessage(
    chainId: number,
    jobId: string,
    content: string,
    contentType: string = "text",
    packageId?: number
  ): Promise<void> {
    await this.transport.postMessage(
      chainId,
      jobId,
      content,
      contentType,
      packageId
    );
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

  async createSubscriptionJob(
    chainId: number,
    params: CreateJobParams
  ): Promise<bigint> {
    const defaultHook = getAddressForChain(
      SUBSCRIPTION_HOOK_ADDRESSES,
      chainId,
      "SubscriptionHook"
    );
    return this.createJob(chainId, {
      ...params,
      hookAddress: params.hookAddress ?? defaultHook,
    });
  }

  async createMultiHookJob(
    chainId: number,
    params: CreateJobParams,
    hookConfig?: MultiHookConfig
  ): Promise<bigint> {
    const routerAddress = getAddressForChain(
      MULTI_HOOK_ROUTER_ADDRESSES,
      chainId,
      "MultiHookRouter"
    );

    const jobId = await this.createJob(chainId, {
      ...params,
      hookAddress: routerAddress,
    });

    if (hookConfig) {
      await this.batchConfigureHooks(chainId, {
        jobId,
        selectors: hookConfig.selectors,
        hooksPerSelector: hookConfig.hooksPerSelector,
        routerAddress,
      });
    }

    return jobId;
  }

  async createJobFromOffering(
    chainId: number,
    offering: AcpAgentOffering,
    providerAddress: string,
    requirementData: Record<string, unknown> | string,
    opts?: {
      evaluatorAddress?: string;
      hookAddress?: string;
      packageId?: number;
    }
  ): Promise<bigint> {
    // Validate requirement data against JSON schema if requirements is an object
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

    let packageId: number | undefined;
    let jobId: bigint;

    if (opts?.packageId) {
      const subscription = offering.subscriptions?.find(
        (s) => s.packageId === Number(opts.packageId)
      );
      if (!subscription) {
        throw new Error(`Package ID ${opts.packageId} not found in offerings`);
      }
      packageId = Number(opts.packageId);
    }

    if (packageId) {
      if (offering.requiredFunds) {
        const hookConfig = buildSubscriptionWithFundsHookConfig(chainId);
        jobId = await this.createMultiHookJob(chainId, jobParams, hookConfig);
      } else {
        jobId = await this.createSubscriptionJob(chainId, jobParams);
      }
    } else {
      jobId = offering.requiredFunds
        ? await this.createFundTransferJob(chainId, jobParams)
        : await this.createJob(chainId, jobParams);
    }

    // Send first message with requirement data.
    // The chat room may not be ready immediately after on-chain job creation,
    // so retry a few times with a short delay.
    const maxRetries = 5;
    const retryDelayMs = 2000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.sendMessage(
          chainId,
          jobId.toString(),
          JSON.stringify(requirementData),
          "requirement",
          packageId
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
      packageId?: number;
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

  async batchConfigureHooks(
    chainId: number,
    params: BatchConfigureHooksAgentParams
  ): Promise<string | string[]> {
    if (!(this.client instanceof EvmAcpClient)) {
      throw new Error("batchConfigureHooks is only supported on EVM chains");
    }
    const prepared = await this.client.batchConfigureHooks(chainId, {
      routerAddress: params.routerAddress,
      jobId: params.jobId,
      selectors: params.selectors,
      hooksPerSelector: params.hooksPerSelector,
    });
    return this.client.submitPrepared(chainId, [prepared]);
  }

  // -------------------------------------------------------------------------
  // Subscription state reads
  // -------------------------------------------------------------------------

  async getSubscriptionExpiry(
    chainId: number,
    client: string,
    provider: string,
    packageId: number
  ): Promise<bigint> {
    if (!(this.client instanceof EvmAcpClient)) {
      throw new Error("getSubscriptionExpiry is only supported on EVM chains");
    }
    const stateAddress = getAddressForChain(
      SUBSCRIPTION_STATE_ADDRESSES,
      chainId,
      "SubscriptionState"
    );
    const result = await this.client.getProvider().readContract(chainId, {
      address: stateAddress,
      abi: SUBSCRIPTION_STATE_ABI as readonly unknown[],
      functionName: "getSubscriptionExpiry",
      args: [client as Address, provider as Address, BigInt(packageId)],
    });
    return result as bigint;
  }

  async isSubscriptionActive(
    chainId: number,
    client: string,
    provider: string,
    packageId: number
  ): Promise<boolean> {
    const expiry = await this.getSubscriptionExpiry(
      chainId,
      client,
      provider,
      packageId
    );
    return expiry > BigInt(Math.floor(Date.now() / 1000));
  }

  async getProposedSubscriptionTerms(
    chainId: number,
    jobId: bigint
  ): Promise<{ duration: bigint; packageId: bigint }> {
    if (!(this.client instanceof EvmAcpClient)) {
      throw new Error(
        "getProposedSubscriptionTerms is only supported on EVM chains"
      );
    }
    const hookAddress = getAddressForChain(
      SUBSCRIPTION_HOOK_ADDRESSES,
      chainId,
      "SubscriptionHook"
    );
    const result = (await this.client.getProvider().readContract(chainId, {
      address: hookAddress,
      abi: SUBSCRIPTION_HOOK_ABI as readonly unknown[],
      functionName: "getProposedTerms",
      args: [jobId],
    })) as { duration: bigint; packageId: bigint };
    return { duration: result.duration, packageId: result.packageId };
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
  async internalSetBudgetWithSubscription(
    chainId: number,
    params: SetBudgetWithSubscriptionParams
  ): Promise<string | string[]> {
    const optParams = encodeSubscriptionOptParams(
      params.duration,
      params.packageId
    );

    return this.internalSetBudget(chainId, {
      jobId: params.jobId,
      amount: params.amount,
      optParams,
    });
  }

  /** @internal */
  async internalFundWithSubscription(
    chainId: number,
    params: FundWithSubscriptionParams
  ): Promise<string | string[]> {
    const approvePrepared = await this.client.approveAllowance(chainId, {
      tokenAddress: params.amount.address,
      spenderAddress: this.client.getContractAddress(chainId),
      amount: params.amount.rawAmount,
    });

    const optParams = encodeSubscriptionOptParams(
      params.duration,
      params.packageId
    );

    const fundPrepared = await this.client.fund(chainId, {
      jobId: params.jobId,
      expectedBudget: params.amount.rawAmount,
      optParams,
    });

    return this.client.submitPrepared(chainId, [approvePrepared, fundPrepared]);
  }

  /** @internal */
  async internalSetBudgetWithSubscriptionAndFundRequest(
    chainId: number,
    params: SetBudgetWithSubscriptionAndFundRequestParams
  ): Promise<string | string[]> {
    const subSlice = encodeSubscriptionOptParams(
      params.duration,
      params.packageId
    );
    const fundSlice = encodeFundTransferOptParams(
      params.transferAmount.address as Address,
      params.transferAmount.rawAmount,
      params.destination
    );
    const optParams = encodeRouterOptParams([subSlice, fundSlice]);

    return this.internalSetBudget(chainId, {
      jobId: params.jobId,
      amount: params.amount,
      optParams,
    });
  }

  async getRouterHooks(
    chainId: number,
    jobId: bigint,
    selector: Hex
  ): Promise<Address[]> {
    if (!(this.client instanceof EvmAcpClient)) {
      throw new Error("getRouterHooks is only supported on EVM chains");
    }
    const router = getAddressForChain(
      MULTI_HOOK_ROUTER_ADDRESSES,
      chainId,
      "MultiHookRouter"
    );
    const result = await this.client.getProvider().readContract(chainId, {
      address: router,
      abi: MULTI_HOOK_ROUTER_ABI as readonly unknown[],
      functionName: "getHooks",
      args: [jobId, selector],
    });
    return result as Address[];
  }

  /** @internal */
  async internalFundViaRouter(
    chainId: number,
    params: FundViaRouterParams
  ): Promise<string | string[]> {
    const approveAcp = await this.client.approveAllowance(chainId, {
      tokenAddress: params.amount.address,
      spenderAddress: this.client.getContractAddress(chainId),
      amount: params.amount.rawAmount,
    });

    const subHookAddr =
      SUBSCRIPTION_HOOK_ADDRESSES[chainId]?.toLowerCase() ?? "";
    const fundHookAddr =
      FUND_TRANSFER_HOOK_ADDRESSES[chainId]?.toLowerCase() ?? "";

    const slices: Hex[] = [];
    const prepared = [approveAcp];

    for (const hook of params.hookConfigs) {
      const normalizedHook = hook.toLowerCase();
      if (subHookAddr && normalizedHook === subHookAddr) {
        if (!params.subscriptionTerms) {
          throw new Error(
            "SubscriptionHook is configured on the router but no subscriptionTerms were provided"
          );
        }
        slices.push(
          encodeSubscriptionOptParams(
            params.subscriptionTerms.duration,
            params.subscriptionTerms.packageId
          )
        );
      } else if (fundHookAddr && normalizedHook === fundHookAddr) {
        if (!params.transferAmount || !params.destination) {
          throw new Error(
            "FundTransferHook is configured on the router but no transferAmount/destination were provided"
          );
        }
        const approveHook = await this.client.approveAllowance(chainId, {
          tokenAddress: params.transferAmount.address,
          spenderAddress: hook,
          amount: params.transferAmount.rawAmount,
        });
        prepared.push(approveHook);
        slices.push(
          encodeFundTransferOptParams(
            params.transferAmount.address as Address,
            params.transferAmount.rawAmount,
            params.destination
          )
        );
      } else {
        throw new Error(
          `Unknown sub-hook configured on router at ${hook}. The SDK can only build optParams slices for SubscriptionHook and FundTransferHook.`
        );
      }
    }

    const optParams = encodeRouterOptParams(slices);

    const fundPrepared = await this.client.fund(chainId, {
      jobId: params.jobId,
      expectedBudget: params.amount.rawAmount,
      optParams,
    });
    prepared.push(fundPrepared);

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
