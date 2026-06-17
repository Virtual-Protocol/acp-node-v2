import { base } from "@account-kit/infra";
import dotenv from "dotenv";
import {
  AcpAgent,
  PrivyAlchemyEvmProviderAdapter,
} from "../../index.js";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// ACP SDK Public Helper Functions — runnable showcase.
//
// This script exercises every public read/introspection API on AcpAgent,
// AcpJobApi, AcpChatTransport, and JobSession. It is intentionally a single
// linear script with delimited subsections (see `subsection()`) so a dev
// can read it top-to-bottom and see exactly which method produces which
// shape of output.
//
// Env vars (from the repo root .env, same keys as basic/buyer.ts):
//   BUYER_WALLET_ADDRESS, BUYER_WALLET_ID, BUYER_SIGNER_PRIVATE_KEY
// Optional:
//   SELLER_WALLET_ADDRESS — exercised by the getAgentByWalletAddress demo
// ---------------------------------------------------------------------------

const chain = base;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function subsection(title: string): void {
  console.log(`\n--- ${title} ---`);
}

function header(title: string): void {
  const bar = "=".repeat(60);
  console.log(`\n${bar}\n${title}\n${bar}`);
}

async function main(): Promise<void> {
  header("ACP SDK Public Helper Functions");

  console.log("\nInitializing ACP agent...");
  const agent = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: requireEnv("BUYER_WALLET_ADDRESS") as `0x${string}`,
      walletId: requireEnv("BUYER_WALLET_ID"),
      signerPrivateKey: requireEnv("BUYER_SIGNER_PRIVATE_KEY"),
      chains: [chain],
    }),
  });

  try {
    // Subsections added in subsequent tasks plug in here.
    /* ---------------- AGENT IDENTITY ---------------- */
    subsection("Agent identity");
    const address = await agent.getAddress();
    console.log(`address:           ${address}`);
    console.log(`supported chains:  ${JSON.stringify(agent.getSupportedChainIds())}`);

    /* ---------------- SELF REGISTRY PROFILE ---------------- */
    subsection("Self registry profile (getMe)");
    try {
      const me = await agent.getMe();
      console.log(`name:              ${me.name}`);
      console.log(`role:              ${me.role}`);
      console.log(`offerings:         ${me.offerings.length}`);
      for (const o of me.offerings) {
        console.log(
          `  - "${o.name}" — ${o.priceValue} USDC, sla=${o.slaMinutes}min, ` +
            `requiredFunds=${o.requiredFunds}, hidden=${o.isHidden}`
        );
      }
      console.log(`subscriptions:     ${me.subscriptions.length}`);
      for (const s of me.subscriptions) {
        console.log(
          `  - "${s.name}" packageId=${s.packageId}, ${s.price} USDC, ${s.duration}s`
        );
      }
    } catch (err) {
      console.log(`getMe failed (is this wallet registered?): ${err}`);
    }

    /* ---------------- DIRECT LOOKUP ---------------- */
    subsection("Direct lookup (getAgentByWalletAddress)");
    const sellerAddress = process.env.SELLER_WALLET_ADDRESS;
    if (sellerAddress) {
      const seller = await agent.getAgentByWalletAddress(sellerAddress);
      if (seller) {
        console.log(
          `found "${seller.name}" at ${seller.walletAddress} — ` +
            `${seller.offerings.length} offering(s)`
        );
      } else {
        console.log(`no agent registered at ${sellerAddress}`);
      }
    } else {
      console.log("skipped — SELLER_WALLET_ADDRESS not set");
    }

    /* ---------------- REGISTRY BROWSE ---------------- */
    subsection("Registry browse (browseAgents)");
    const browsed = await agent.browseAgents("agent", {
      topK: 3,
      showHidden: true,
    });
    console.log(`top ${browsed.length} agent(s) matching "agent":`);
    for (const a of browsed) {
      console.log(
        `  - "${a.name}" ${a.walletAddress} — ${a.offerings.length} offering(s)`
      );
    }

    /* ---------------- ACTIVE JOBS ---------------- */
    subsection("Active jobs (getApi().getActiveJobs)");
    const api = agent.getApi();
    const activeJobs = await api.getActiveJobs();
    console.log(`${activeJobs.length} active job(s):`);

    // Inspect up to the first 3 active jobs in detail. v1's helper paged
    // with `getActiveJobs(1, 3)`; v2's getActiveJobs() returns all jobs the
    // wallet is on (no pagination), so we slice client-side.
    for (const ref of activeJobs.slice(0, 3)) {
      console.log(`\n  job ${ref.onChainJobId} on chain ${ref.chainId}:`);

      /* ---- per-job off-chain record ---- */
      const job = await api.getJob(ref.chainId, ref.onChainJobId);
      if (!job) {
        console.log(`    (no off-chain record)`);
        continue;
      }
      console.log(`    status:      ${job.jobStatus}`);
      console.log(`    client:      ${job.clientAddress}`);
      console.log(`    provider:    ${job.providerAddress}`);
      console.log(`    evaluator:   ${job.evaluatorAddress}`);
      console.log(`    description: ${job.description ?? "(none)"}`);
      console.log(`    budget:      ${job.budget ?? "(unset)"}`);
      console.log(`    expiredAt:   ${job.expiredAt}`);
      console.log(`    hookAddress: ${job.hookAddress ?? "(none)"}`);
      if (job.hookConfigs) {
        console.log(`    hookConfigs: ${JSON.stringify(job.hookConfigs)}`);
      }
      if (job.intents && job.intents.length > 0) {
        console.log(`    intents:     ${job.intents.length}`);
        for (const i of job.intents) {
          console.log(
            `      - ${i.actor} → ${i.recipientAddress}, ` +
              `${i.amount ?? "(amount tbd)"} ${i.tokenAddress ?? ""} ` +
              `(escrow=${i.isEscrow}, signed=${i.isSigned})`
          );
        }
      }

      /* ---- per-job chat history ---- */
      const transport = agent.getTransport();
      const history = await transport.getHistory(ref.chainId, ref.onChainJobId);
      console.log(`    history:     ${history.length} entry(ies)`);
      for (const e of history.slice(-3)) {
        if (e.kind === "system") {
          console.log(`      [system] ${e.event.type}`);
        } else {
          const preview = e.content.length > 60
            ? `${e.content.slice(0, 60)}…`
            : e.content;
          console.log(`      [${e.from}] (${e.contentType}) ${preview}`);
        }
      }
    }

    if (activeJobs.length > 3) {
      console.log(`\n  …and ${activeJobs.length - 3} more`);
    }

    // Note: agent.getRouterHooks(chainId, jobId, selector) is also a public
    // read API — call it when a multi-hook router job is in flight to see
    // which sub-hooks are configured for a given selector. Skipped here
    // because demoing it requires fabricating selector bytes.

    /* ---------------- HYDRATED SESSIONS ---------------- */
    subsection("Hydrated sessions (after agent.start)");
    // agent.start() opens the SSE transport and calls hydrateSessions(),
    // which builds a JobSession for every active job this wallet is on.
    // The single-entry handler is a no-op here — we only want hydration.
    agent.on("entry", () => {});
    await agent.start();
    const sessions = agent.sessions;
    console.log(`${sessions.length} hydrated session(s):`);
    for (const s of sessions.slice(0, 3)) {
      console.log(
        `  - job ${s.jobId} (chain ${s.chainId}): status=${s.status}, ` +
          `roles=[${s.roles.join(",")}], entries=${s.entries.length}`
      );
      console.log(
        `    availableTools: [${s.availableTools().map((t) => t.name).join(", ")}]`
      );
    }

    /* ---------------- SESSION RENDER ---------------- */
    subsection("Session render (toContext / toMessages)");
    const sample = sessions[0];
    if (sample) {
      // session.fetchJob() forces a refresh of session.job from the backend
      // — useful when you need the latest off-chain state mid-flow. After
      // hydration the SDK has typically already populated session.job.
      await sample.fetchJob();
      console.log(`sample session: job ${sample.jobId}`);
      console.log("\n  toContext():");
      const ctx = await sample.toContext();
      for (const line of ctx.split("\n").slice(0, 8)) {
        console.log(`    ${line}`);
      }
      const ctxLines = ctx.split("\n").length;
      if (ctxLines > 8) console.log(`    …(${ctxLines - 8} more line(s))`);

      console.log("\n  toMessages() (LLM-shaped):");
      const msgs = await sample.toMessages();
      for (const m of msgs.slice(0, 4)) {
        const preview =
          m.content.length > 80 ? `${m.content.slice(0, 80)}…` : m.content;
        console.log(`    ${m.role}: ${preview}`);
      }
      if (msgs.length > 4) console.log(`    …(${msgs.length - 4} more)`);
    } else {
      console.log("no hydrated sessions to render — skipping");
    }

    /* ---------------- SUBSCRIPTION STATE ---------------- */
    subsection("Subscription state (on-chain reads)");
    // These three methods read from the SubscriptionHook + SubscriptionState
    // contracts. They only return meaningful data when there's a job using
    // the SubscriptionHook in scope, so we look for one before calling.
    const subscriptionSession = sessions.find((s) => {
      const hook = s.job?.hookAddress?.toLowerCase();
      const subHook = (
        process.env.SUBSCRIPTION_HOOK_ADDRESS ?? ""
      ).toLowerCase();
      // Prefer the strict signal: jobs that activated a subscription
      // expose `clientSubscription` on AcpJob. Fall back to a hookConfigs
      // truthiness check (set by SubscriptionHook + MultiHookRouter jobs)
      // or an explicit env override.
      return (
        s.job?.clientSubscription != null ||
        Boolean(s.job?.hookConfigs) ||
        (subHook && hook === subHook)
      );
    });

    if (!subscriptionSession || !subscriptionSession.job) {
      console.log(
        "no subscription-hook session in scope — skipping " +
          "(set up a subscription/ example flow first to exercise this)"
      );
    } else {
      const job = subscriptionSession.job;
      console.log(`probing subscription state for job ${subscriptionSession.jobId}`);

      try {
        const terms = await agent.getProposedSubscriptionTerms(
          subscriptionSession.chainId,
          BigInt(subscriptionSession.jobId)
        );
        console.log(
          `  proposed terms: duration=${terms.duration}s, packageId=${terms.packageId}`
        );

        const packageId = Number(terms.packageId);
        const expiry = await agent.getSubscriptionExpiry(
          subscriptionSession.chainId,
          job.clientAddress,
          job.providerAddress,
          packageId
        );
        const isActive = await agent.isSubscriptionActive(
          subscriptionSession.chainId,
          job.clientAddress,
          job.providerAddress,
          packageId
        );
        const nowSec = Math.floor(Date.now() / 1000);
        const remaining = Number(expiry) - nowSec;
        console.log(
          `  expiry:         ${expiry} (${
            remaining > 0 ? `${remaining}s remaining` : "expired"
          })`
        );
        console.log(`  isActive:       ${isActive}`);
      } catch (err) {
        console.log(`  subscription read failed: ${err}`);
      }
    }

    /* ---------------- ASSET TOKEN RESOLUTION ---------------- */
    subsection("Asset token resolution");
    // resolveAssetToken / resolveRawAssetToken read decimals + symbol from
    // the ERC-20 contract and return an AssetToken — useful when you have
    // a token address but don't know its decimals. AssetToken.usdc(...) is
    // the shorthand most examples use; this section demonstrates the
    // general path for any ERC-20 (e.g. a chain-specific WETH).
    //
    // We resolve USDC on the configured chain by re-using the token address
    // recorded on a session's job (every job carries a budget token via
    // its hookConfigs / ACP contract address resolution). Skipped if no
    // session is available.
    if (sample?.job) {
      const intent = sample.job.getFundRequestIntent() ?? sample.job.getFundTransferIntent();
      const tokenAddress = (intent?.tokenAddress ?? null) as `0x${string}` | null;
      if (tokenAddress) {
        const oneUnit = await agent.resolveAssetToken(
          tokenAddress,
          1,
          sample.chainId
        );
        console.log(
          `  resolveAssetToken: 1 of ${tokenAddress} → ` +
            `${oneUnit.amount} ${oneUnit.symbol} (raw ${oneUnit.rawAmount})`
        );

        const oneRaw = await agent.resolveRawAssetToken(
          tokenAddress,
          1_000_000n,
          sample.chainId
        );
        console.log(
          `  resolveRawAssetToken: 1_000_000 raw of ${tokenAddress} → ` +
            `${oneRaw.amount} ${oneRaw.symbol}`
        );
      } else {
        console.log("skipped — no token address available on the sample session");
      }
    } else {
      console.log("skipped — no sample session available");
    }
  } finally {
    await agent.stop();
  }
}

main()
  .then(() => {
    console.log("\nDone.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nError running helper functions:", err);
    process.exit(1);
  });
