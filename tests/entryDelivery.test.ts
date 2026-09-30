/**
 * Delivery guarantees for the `entry` handler.
 *
 * Covers the ordering inside `AcpAgent.start()`: the stream goes live before
 * hydration finishes, so entries can arrive while sessions are still being
 * rebuilt. Every case here is about a handler running exactly once — never
 * twice (a second on-chain ruling) and never zero times (a job left hanging).
 *
 * Run with `npm test`. No framework: plain assertions over fake transports, so
 * nothing here touches the network or a chain.
 */
import assert from "node:assert/strict";
import { AcpAgent } from "../src/acpAgent.js";
import { AcpJobStatus } from "../src/events/types.js";
import type {
  AcpAgentDetail,
  AcpChatTransport,
  AcpJobApi,
  JobRoomEntry,
  OffChainJob,
  SupportedStreams,
} from "../src/events/types.js";

const CHAIN = 8453;
const JOB = "4242";
const CLIENT = "0x1111111111111111111111111111111111111111";
const PROVIDER = "0x2222222222222222222222222222222222222222";
const EVALUATOR = "0x3333333333333333333333333333333333333333";

const tick = (ms = 25): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Fresh object per call throughout: the SSE frame and the getHistory response
// are parsed separately, so the same logical entry is never the same reference.
const createdEntry = (): JobRoomEntry => ({
  kind: "system",
  chainId: CHAIN,
  onChainJobId: JOB,
  timestamp: 1_000,
  event: {
    type: "job.created",
    onChainJobId: JOB,
    client: CLIENT,
    provider: PROVIDER,
    evaluator: EVALUATOR,
  },
} as unknown as JobRoomEntry);

const fundedEntry = (): JobRoomEntry => ({
  kind: "system",
  chainId: CHAIN,
  onChainJobId: JOB,
  timestamp: 2_000,
  event: { type: "job.funded", onChainJobId: JOB, client: CLIENT, amount: 0.01 },
} as unknown as JobRoomEntry);

const submittedEntry = (): JobRoomEntry => ({
  kind: "system",
  chainId: CHAIN,
  onChainJobId: JOB,
  timestamp: 3_000,
  event: {
    type: "job.submitted",
    onChainJobId: JOB,
    provider: PROVIDER,
    deliverableHash: "0xabc",
    deliverable: "the deliverable",
  },
} as unknown as JobRoomEntry);

type FakeOpts = {
  /** Entries the server pushes while `hydrateSessions()` is still running. */
  duringHydration?: () => JobRoomEntry[];
  /** What `getHistory` returns, after `historyDelayMs`. */
  history?: () => JobRoomEntry[];
  historyDelayMs?: number;
  /** Jobs `getActiveJobs()` reports; empty means nothing to hydrate. */
  activeJobs?: { chainId: number; onChainJobId: string }[];
  jobStatus?: AcpJobStatus;
  /** Fail the first N `getJob()` calls (simulates observer lag). */
  getJobFailCount?: number;
};

class FakeTransport implements AcpChatTransport {
  handler: ((entry: JobRoomEntry) => void) | null = null;
  historyCalls = 0;
  constructor(private readonly opts: FakeOpts) {}

  async connect(onConnected?: () => void, _s?: SupportedStreams[]): Promise<void> {
    onConnected?.();
    const pushed = this.opts.duringHydration?.() ?? [];
    // Land after connect() resolves, i.e. inside the hydration window.
    for (const entry of pushed) setTimeout(() => this.emit(entry), 0);
  }
  async disconnect(): Promise<void> {}
  onEntry(handler: (entry: JobRoomEntry) => void): void {
    this.handler = handler;
  }
  emit(entry: JobRoomEntry): void {
    this.handler?.(entry);
  }
  sendMessage(): void {}
  async postMessage(): Promise<void> {}
  async getHistory(): Promise<JobRoomEntry[]> {
    this.historyCalls++;
    await tick(this.opts.historyDelayMs ?? 20);
    return this.opts.history?.() ?? [];
  }
}

class FakeApi implements AcpJobApi {
  getJobCalls = 0;
  constructor(private readonly opts: FakeOpts) {}
  async getActiveJobs() {
    return this.opts.activeJobs ?? [{ chainId: CHAIN, onChainJobId: JOB }];
  }
  async getJob(): Promise<OffChainJob | null> {
    this.getJobCalls++;
    if (
      this.opts.getJobFailCount !== undefined &&
      this.getJobCalls <= this.opts.getJobFailCount
    ) {
      throw new Error("observer lag");
    }
    return {
      chainId: CHAIN,
      onChainJobId: JOB,
      jobStatus: this.opts.jobStatus ?? AcpJobStatus.FUNDED,
      clientAddress: CLIENT,
      providerAddress: PROVIDER,
      evaluatorAddress: EVALUATOR,
      description: "test job",
      budget: "10000",
      expiredAt: new Date(Date.now() + 600_000).toISOString(),
      hookAddress: null,
      deliverable: "the deliverable",
      hookConfigs: null,
      clientSubscription: null,
    };
  }
  async postDeliverable(): Promise<void> {}
  async browseAgents(): Promise<AcpAgentDetail[]> {
    return [];
  }
  async getAgentByWalletAddress(): Promise<AcpAgentDetail | null> {
    return null;
  }
}

type Harness = {
  agent: AcpAgent;
  transport: FakeTransport;
  /** One entry per handler invocation, in order. */
  fires: JobRoomEntry[];
  firesOf: (eventType: string) => number;
};

async function harness(myAddress: string, opts: FakeOpts = {}): Promise<Harness> {
  const transport = new FakeTransport(opts);
  const api = new FakeApi(opts);
  const agent = new AcpAgent(new Map(), transport, api);
  // buildTransportContext() normally fills this from the provider adapters.
  (agent as unknown as { addresses: Map<string, string> }).addresses.set(
    "evm",
    myAddress,
  );
  const fires: JobRoomEntry[] = [];
  agent.on("entry", (_session, entry) => {
    fires.push(entry);
  });
  await agent.start();
  await tick(60); // let queued/live dispatches settle
  return {
    agent,
    transport,
    fires,
    firesOf: (eventType) =>
      fires.filter((e) => e.kind === "system" && e.event.type === eventType)
        .length,
  };
}

// ---------------------------------------------------------------------------

const tests: Array<[string, () => Promise<void>]> = [
  [
    "entry arriving mid-hydration is delivered once, with the evaluator's real role",
    async () => {
      const h = await harness(EVALUATOR, {
        duringHydration: () => [submittedEntry()],
        history: () => [createdEntry(), fundedEntry(), submittedEntry()],
        jobStatus: AcpJobStatus.SUBMITTED,
      });
      const session = h.agent.getSession(CHAIN, JOB)!;
      // Roles come from job.created; a session built from the live entry alone
      // would default to ["provider"] and drop the ruling entirely.
      assert.deepEqual(session.roles, ["evaluator"]);
      assert.equal(h.firesOf("job.submitted"), 1);
      assert.equal(session.entries.length, 3);
      assert.equal(session.status, "submitted");
    },
  ],
  [
    "entry arriving mid-hydration is not delivered twice to a provider",
    async () => {
      const h = await harness(PROVIDER, {
        duringHydration: () => [fundedEntry()],
        history: () => [createdEntry(), fundedEntry()],
      });
      // The pre-fix failure: live dispatch fired, then hydration replayed the
      // same entry as the job's latest — two submits for one funding.
      assert.equal(h.firesOf("job.funded"), 1);
      assert.equal(h.agent.getSession(CHAIN, JOB)!.entries.length, 2);
    },
  ],
  [
    "hydration still replays the latest entry on a cold start (restart resumption)",
    async () => {
      const h = await harness(PROVIDER, {
        history: () => [createdEntry(), fundedEntry()],
      });
      // The replay is the feature: a provider killed at job.funded must be
      // asked to deliver again on the next boot.
      assert.equal(h.firesOf("job.funded"), 1);
      assert.equal(h.firesOf("job.created"), 0, "only the latest entry replays");
    },
  ],
  [
    "the same live entry delivered twice reaches the handler once",
    async () => {
      const h = await harness(PROVIDER, {
        activeJobs: [],
        history: () => [createdEntry(), fundedEntry()],
      });
      h.transport.emit(createdEntry());
      await tick();
      h.transport.emit(fundedEntry());
      await tick();
      h.transport.emit(fundedEntry()); // reconnect replay, distinct object
      await tick();
      assert.equal(h.firesOf("job.funded"), 1);
      const session = h.agent.getSession(CHAIN, JOB)!;
      assert.equal(
        session.entries.filter(
          (e) => e.kind === "system" && e.event.type === "job.funded",
        ).length,
        1,
        "transcript must not double up",
      );
    },
  ],
  [
    "a live job.created stands up a session without fetching history",
    async () => {
      const h = await harness(PROVIDER, { activeJobs: [] });
      const before = h.transport.historyCalls;
      h.transport.emit(createdEntry());
      await tick();
      assert.equal(h.firesOf("job.created"), 1);
      assert.deepEqual(h.agent.getSession(CHAIN, JOB)!.roles, ["provider"]);
      assert.equal(
        h.transport.historyCalls,
        before,
        "job.created carries the role addresses; no round-trip needed",
      );
    },
  ],
  [
    "a first sighting that isn't job.created pulls history to resolve roles",
    async () => {
      const h = await harness(EVALUATOR, {
        activeJobs: [],
        history: () => [createdEntry(), fundedEntry(), submittedEntry()],
        jobStatus: AcpJobStatus.SUBMITTED,
      });
      h.transport.emit(submittedEntry());
      await tick(60);
      const session = h.agent.getSession(CHAIN, JOB)!;
      assert.deepEqual(session.roles, ["evaluator"]);
      assert.equal(h.firesOf("job.submitted"), 1, "must still fire exactly once");
      assert.equal(session.status, "submitted");
    },
  ],
  [
    "merged history keeps status on the newest event, not the last one appended",
    async () => {
      const h = await harness(PROVIDER, {
        activeJobs: [],
        // History is older than the live entry that created the session.
        history: () => [createdEntry(), fundedEntry()],
      });
      h.transport.emit(submittedEntry());
      await tick(60);
      const session = h.agent.getSession(CHAIN, JOB)!;
      assert.equal(
        session.status,
        "submitted",
        "appending older history must not walk status backwards",
      );
      assert.deepEqual(
        session.entries.map((e) => e.timestamp),
        [1_000, 2_000, 3_000],
      );
    },
  ],
  [
    "a transient getJob failure during hydration retries on drain, not zero times",
    async () => {
      const h = await harness(PROVIDER, {
        duringHydration: () => [fundedEntry()],
        history: () => [createdEntry(), fundedEntry()],
        getJobFailCount: 1,
      });
      assert.equal(
        h.firesOf("job.funded"),
        1,
        "hydration failure must not permanently skip the handler",
      );
    },
  ],
  [
    "a transient getJob failure on live dispatch retries on reconnect replay",
    async () => {
      const h = await harness(PROVIDER, {
        activeJobs: [],
        history: () => [createdEntry(), fundedEntry()],
        getJobFailCount: 1,
      });
      h.transport.emit(fundedEntry());
      await tick();
      h.transport.emit(fundedEntry()); // reconnect replay after fetchJob recovers
      await tick(60);
      assert.equal(h.firesOf("job.funded"), 1);
    },
  ],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message.split("\n").join("\n       ")}`);
  }
}
console.log(
  `\n${tests.length - failed}/${tests.length} passed${failed ? ` — ${failed} FAILED` : ""}`,
);
process.exit(failed ? 1 : 0);
