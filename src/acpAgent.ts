import { encodeAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
import {
  type AcpClient,
  type CreateAcpClientInput,
  createAcpClients,
} from "./clientFactory.js";
import { EvmAcpClient } from "./clients/evmAcpClient.js";
import { SolanaAcpClient } from "./clients/solanaAcpClient.js";
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
  type ChainFamily,
  getChainFamily,
} from "./core/constants.js";
import { SUBSCRIPTION_STATE_ABI } from "./core/subscriptionStateAbi.js";
import { SUBSCRIPTION_HOOK_ABI } from "./core/subscriptionHookAbi.js";
import { MULTI_HOOK_ROUTER_ABI } from "./core/multiHookRouterAbi.js";
import {
  buildSubscriptionWithFundsHookConfig,
  encodeFundTransferOptParams,
  encodeFundTransferSetBudgetOptParams,
  encodeFundTransferFundOptParams,
  encodeFundTransferSubmitOptParams,
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
  destination: string;
  clientAddress?: string;
};

export type FundWithTransferParams = {
  jobId: bigint;
  amount: AssetToken;
  transferAmount: AssetToken;
  destination: string;
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
  destination: string;
};

export type FundViaRouterParams = {
  jobId: bigint;
  amount: AssetToken;
  hookConfigs: string[];
  subscriptionTerms?: { duration: bigint; packageId: bigint };
  transferAmount?: AssetToken;
  destination?: string;
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
  private readonly clients: Map<ChainFamily, AcpClient>;
  private readonly transport: AcpChatTransport;
  private readonly api: AcpJobApi;
  private started = false;
  private entryHandler: EntryHandler | null = null;
  private sessionMap = new Map<string, JobSession>();
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

  async getMe(): Promise<AcpAgentDetail> {
    const address = await this.getAddress();
    const agent = await this.api.getAgentByWalletAddress(address);
    if (!agent) {
      throw new Error(`No agent found for wallet address: ${address}`);
    }
    return agent;
  }

  async getAddress(family?: ChainFamily): Promise<string> {
    if (family !== undefined) {
      if (!this.addresses.has(family)) {
        const client = this.clients.get(family);
        if (!client) {
          throw new Error(`No ${family} client configured for ${family} family`);
        }
        this.addresses.set(family, await client.getAddress());
      }
      return this.addresses.get(family)!;
    }

    if (this.addresses.has("evm")) {
      return this.addresses.get("evm")!;
    }

    for (const fam of this.clients.keys()) {
      return this.getAddress(fam);
    }

    throw new Error("No clients configured");
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
      [...this.addresses.values()],
      jobId,
      chainId,
      roles,
      initialEntries
    );
    this.sessionMap.set(this.getSessionKey(chainId, jobId), session);
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
    const client = this.getClient(chainId);
    if (!(client instanceof EvmAcpClient)) {
      throw new Error("batchConfigureHooks is only supported on EVM chains");
    }
    const prepared = await client.batchConfigureHooks(chainId, {
      routerAddress: params.routerAddress,
      jobId: params.jobId,
      selectors: params.selectors,
      hooksPerSelector: params.hooksPerSelector,
    });
    return client.submitPrepared(chainId, [prepared]);
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
    const acpClient = this.getClient(chainId);
    if (!(acpClient instanceof EvmAcpClient)) {
      throw new Error("getSubscriptionExpiry is only supported on EVM chains");
    }
    const stateAddress = getAddressForChain(
      SUBSCRIPTION_STATE_ADDRESSES,
      chainId,
      "SubscriptionState"
    );
    const result = await acpClient.getProvider().readContract(chainId, {
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
    const acpClient = this.getClient(chainId);
    if (!(acpClient instanceof EvmAcpClient)) {
      throw new Error(
        "getProposedSubscriptionTerms is only supported on EVM chains"
      );
    }
    const hookAddress = getAddressForChain(
      SUBSCRIPTION_HOOK_ADDRESSES,
      chainId,
      "SubscriptionHook"
    );
    const result = (await acpClient.getProvider().readContract(chainId, {
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
    const optParams = encodeFundTransferSetBudgetOptParams(
      chainId,
      params.transferAmount.address,
      params.transferAmount.rawAmount,
      params.destination
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

    const optParams: Hex = encodeFundTransferFundOptParams(
      chainId,
      params.transferAmount.address,
      params.transferAmount.rawAmount,
      params.destination
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

    const optParams = encodeSubscriptionOptParams(
      params.duration,
      params.packageId
    );

    prepared.push(
      await client.fund(chainId, {
        jobId: params.jobId,
        expectedBudget: params.amount.rawAmount,
        optParams,
      })
    );

    return client.submitPrepared(chainId, prepared);
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
      params.destination as Address
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
    const client = this.getClient(chainId);
    if (!(client instanceof EvmAcpClient)) {
      throw new Error("getRouterHooks is only supported on EVM chains");
    }
    const router = getAddressForChain(
      MULTI_HOOK_ROUTER_ADDRESSES,
      chainId,
      "MultiHookRouter"
    );
    const result = await client.getProvider().readContract(chainId, {
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

    const subHookAddr =
      SUBSCRIPTION_HOOK_ADDRESSES[chainId]?.toLowerCase() ?? "";
    const fundHookAddr =
      FUND_TRANSFER_HOOK_ADDRESSES[chainId]?.toLowerCase() ?? "";

    const slices: Hex[] = [];

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
        if (client.getCapabilities().supportsAllowance) {
          prepared.push(
            await client.approveAllowance(chainId, {
              tokenAddress: params.transferAmount.address,
              spenderAddress: hook,
              amount: params.transferAmount.rawAmount,
            })
          );
        }
        slices.push(
          encodeFundTransferOptParams(
            params.transferAmount.address as Address,
            params.transferAmount.rawAmount,
            params.destination as Address
          )
        );
      } else {
        throw new Error(
          `Unknown sub-hook configured on router at ${hook}. The SDK can only build optParams slices for SubscriptionHook and FundTransferHook.`
        );
      }
    }

    const optParams = encodeRouterOptParams(slices);

    prepared.push(
      await client.fund(chainId, {
        jobId: params.jobId,
        expectedBudget: params.amount.rawAmount,
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

    const optParams: Hex = encodeFundTransferSubmitOptParams(
      chainId,
      params.transferAmount.address,
      params.transferAmount.rawAmount
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
