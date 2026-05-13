import { encodeAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
import {
  type AcpClient,
  type CreateAcpClientInput,
  createAcpClient,
} from "./clientFactory.js";
import { EvmAcpClient } from "./clients/evmAcpClient.js";
import type {
  CompleteParams,
  CreateJobParams,
  RejectParams,
  SubmitParams,
} from "./core/operations.js";
import {
  FUND_TRANSFER_HOOK_ADDRESSES,
  MULTI_HOOK_ROUTER_ADDRESSES,
  SUBSCRIPTION_HOOK_ADDRESSES,
  SUBSCRIPTION_STATE_ADDRESSES,
  getAddressForChain,
  MIN_SLA_MINS,
  BUFFER_SECONDS,
} from "./core/constants.js";
import { SUBSCRIPTION_STATE_ABI } from "./core/subscriptionStateAbi.js";
import { SUBSCRIPTION_HOOK_ABI } from "./core/subscriptionHookAbi.js";
import { MULTI_HOOK_ROUTER_ABI } from "./core/multiHookRouterAbi.js";
import {
  buildSubscriptionWithFundsHookConfig,
  encodeFundTransferOptParams,
  encodeRouterOptParams,
  encodeSubscriptionOptParams,
  type MultiHookConfig,
} from "./core/hookEncoding.js";
import { AssetToken } from "./core/assetToken.js";
import { JobSession } from "./jobSession.js";
import { AcpApiClient } from "./events/acpApiClient.js";
import { AcpHttpClient } from "./events/acpHttpClient.js";
import type {
  AcpAgentDetail,
  AcpAgentOffering,
  AcpChatTransport,
  AcpJobApi,
  AgentRole,
  BrowseAgentParams,
  JobRoomEntry,
  SupportedStreams,
  TransportContext,
} from "./events/types.js";
import { DEFAULT_STREAMS, SseTransport } from "./events/sseTransport.js";

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
  private sessionMap = new Map<string, JobSession>();
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
      signTypedData: (chainId: number, typedData: unknown) => {
        if (this.client instanceof EvmAcpClient) {
          return this.client.getProvider().signTypedData(chainId, typedData);
        }
        throw new Error("signTypedData is not supported for this provider");
      },
    };
  }

  async start(
    onConnected?: () => void,
    streams: SupportedStreams[] = DEFAULT_STREAMS
  ): Promise<void> {
    if (this.started) {
      throw new Error("Agent already started. Call stop() first.");
    }

    this.started = true;

    this.transport.onEntry((entry) =>
      this.dispatch(entry).catch(console.error)
    );
    await this.transport.connect(onConnected, streams);

    await this.hydrateSessions();
  }

  async stop(): Promise<void> {
    if (this.started) {
      await this.transport.disconnect();
      this.started = false;
    }
    this.sessionMap.clear();
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
    return this.sessionMap.get(this.getSessionKey(chainId, jobId));
  }

  /**
   * All sessions currently tracked by this agent.
   *
   * After `start()`, this includes every job hydrated from
   * `AcpJobApi.getActiveJobs()` plus any sessions created live during the
   * run. Sessions stay in the map across status transitions until `stop()`
   * clears them — filter by `session.status` if you only want non-terminal
   * jobs.
   *
   * Use this on startup to detect in-flight jobs that should be resumed
   * rather than re-initiated:
   *
   * ```ts
   * await agent.start();
   * const inFlight = agent.sessions.filter(
   *   (s) => s.roles.includes("client") &&
   *     !["completed", "rejected", "expired"].includes(s.status)
   * );
   * if (inFlight.length === 0) {
   *   await agent.createJobFromOffering(...);
   * }
   * ```
   */
  get sessions(): JobSession[] {
    return Array.from(this.sessionMap.values());
  }

  private getOrCreateSession(
    jobId: string,
    chainId: number,
    initialEntries: JobRoomEntry[] = []
  ): JobSession {
    let session = this.sessionMap.get(this.getSessionKey(chainId, jobId));
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
    this.sessionMap.set(this.getSessionKey(chainId, jobId), session);
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
        this.sessionMap.set(this.getSessionKey(chainId, jobId), newSession);
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

  /**
   * Create a job from a registry offering and send the requirement message.
   *
   * The `opts.evaluatorAddress` choice picks one of three lifecycle shapes:
   *
   *   • **Self-evaluation** — `{ evaluatorAddress: <buyer> }`.
   *     The buyer is their own evaluator. They receive `job.submitted`
   *     and must call `session.complete(...)` or `session.reject(...)`
   *     themselves to release funds (or refund).
   *
   *   • **Third-party evaluation** — `{ evaluatorAddress: <other wallet> }`.
   *     A separate agent on that wallet must call `complete`/`reject` on
   *     `job.submitted`. The buyer only observes the terminal
   *     `job.completed` / `job.rejected` events.
   *
   *   • **Skip evaluation** — omit `evaluatorAddress` (defaults to the
   *     zero address). The contract treats this as "no evaluator required":
   *     a successful `submit` auto-completes the job and releases funds.
   *     `job.submitted` won't fire for anyone in this mode. Suitable for
   *     trusted-provider flows where the buyer doesn't need a quality gate
   *     before payment.
   *
   * @param chainId            Chain to create the job on.
   * @param offering           Offering to fulfill (selects price + SLA).
   * @param providerAddress    Provider's wallet address.
   * @param requirementData    Requirement payload, validated against
   *                           `offering.requirements` if it's a JSON schema.
   * @param opts.evaluatorAddress  See above. Defaults to the zero address
   *                               (skip-evaluation mode).
   * @param opts.hookAddress       Optional fund-transfer hook override.
   */
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
    // Validate requirement data against JSON schema if requirements is an object.
    if (
      offering.requirements &&
      typeof offering.requirements === "object" &&
      typeof requirementData === "object"
    ) {
      const ajv = new Ajv({ allErrors: true, strictSchema: false });
      addFormats(ajv);
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

  /**
   * Convenience wrapper: looks up the provider, finds the offering by name,
   * and forwards to {@link createJobFromOffering}.
   *
   * See `createJobFromOffering` for the three evaluation modes the
   * `opts.evaluatorAddress` choice selects (self / third-party / skip).
   * Notably, omitting `evaluatorAddress` defaults to the zero address,
   * which puts the job in **skip-evaluation** mode (auto-completes on
   * deliverable submission). Pass an explicit address if you want a
   * quality gate before payment.
   */
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
