import { base } from "@account-kit/infra";
import dotenv from "dotenv";
import * as readline from "node:readline";
import {
  AcpAgent,
  PrivyAlchemyEvmProviderAdapter,
  type JobRoomEntry,
  type JobSession,
} from "../../index.js";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// Subscription buyer lifecycle:
//
//   Same on-chain flow as basic/buyer.ts (browse/lookup → offering →
//   createJobFromOffering → fund on budget.set → complete on job.submitted),
//   with one subscription-specific twist at job creation:
//
//     • The chosen offering has one or more `subscriptions` entries (a
//       package the seller offers — price + duration). Pass its `packageId`
//       to `createJobFromOffering` and the SDK creates a SubscriptionHook
//       job (or a SubscriptionHook + FundTransferHook multi-hook job if
//       the offering also has `requiredFunds: true`).
//
//     • The seller's setBudget will then bake the subscription fee into
//       the budget (only the first time — once the subscription is active,
//       the seller charges only the offering price for follow-up jobs).
//
//   Funding: `session.fund()` (no args) detects the SubscriptionHook from
//   the on-chain job and calls the right path automatically — no extra work
//   on the buyer side.
//
// Required env vars (see .env.example):
//   BUYER_WALLET_ADDRESS, BUYER_WALLET_ID, BUYER_SIGNER_PRIVATE_KEY,
//   SELLER_WALLET_ADDRESS
// ---------------------------------------------------------------------------

const shortAddr = (a: string): string =>
  !a || !a.startsWith("0x") || a.length < 12
    ? a
    : `${a.slice(0, 6)}…${a.slice(-4)}`;

const counterpartyRole = (session: JobSession, addr: string): string => {
  const job = session.job;
  if (!job) return "peer";
  const a = addr.toLowerCase();
  if (job.clientAddress.toLowerCase() === a) return "client";
  if (job.providerAddress.toLowerCase() === a) return "provider";
  if (job.evaluatorAddress.toLowerCase() === a) return "evaluator";
  return "peer";
};

const log = {
  info: (m: string) => console.log(`[buyer-sub] ${m}`),
  job: (id: string | number, m: string) =>
    console.log(`[buyer-sub] [job ${id}] ${m}`),
  chat: (session: JobSession, from: string, content: string) =>
    console.log(
      `[buyer-sub] [job ${session.jobId}] ${counterpartyRole(
        session,
        from
      )} ${shortAddr(from)}: ${content}`
    ),
  send: (session: JobSession, content: string) =>
    console.log(`[buyer-sub] [job ${session.jobId}] me: ${content}`),
  warn: (m: string) => console.warn(`[buyer-sub] [warn] ${m}`),
  error: (m: string, e?: unknown) =>
    console.error(`[buyer-sub] [error] ${m}`, e ?? ""),
};

const chain = base;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(defaultYes);
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "") return resolve(defaultYes);
      resolve(a === "y" || a === "yes");
    });
  });
}

async function main(): Promise<void> {
  const buyer = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: requireEnv("BUYER_WALLET_ADDRESS") as `0x${string}`,
      walletId: requireEnv("BUYER_WALLET_ID"),
      signerPrivateKey: requireEnv("BUYER_SIGNER_PRIVATE_KEY"),
      chains: [chain],
    }),
  });

  const buyerAddress = await buyer.getAddress();
  const buyerAddressLower = buyerAddress.toLowerCase();
  log.info(`address: ${buyerAddress}`);

  buyer.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (
      entry.kind === "message" &&
      entry.from.toLowerCase() !== buyerAddressLower
    ) {
      log.chat(session, entry.from, entry.content);
    }

    if (entry.kind === "system") {
      switch (entry.event.type) {
        case "budget.set": {
          // The seller-side budget bakes in the subscription fee on the first
          // job (offering price + subscription price) and drops to just the
          // offering price on subsequent jobs while the subscription is
          // still active. The buyer doesn't need to know which case applies —
          // we just fund whatever was proposed (subject to policy below).
          const proposedUsdc = entry.event.amount;
          log.job(session.jobId, `proposed budget ${proposedUsdc} USDC`);

          // ▸ Reject point #1 — budget policy.
          //   First-job budgets include the subscription fee, so set the cap
          //   high enough to cover both. After the subscription is active,
          //   the budget should drop to the offering price.
          //
          //   const MAX_USDC = 5.0;
          //   if (proposedUsdc > MAX_USDC) {
          //     await session.sendMessage(
          //       `Budget ${proposedUsdc} USDC exceeds cap ${MAX_USDC} USDC`
          //     );
          //     await session.reject("budget over cap");
          //     return;
          //   }

          try {
            log.send(session, "Looks good, funding now.");
            await session.sendMessage("Looks good, funding now.");
            // `session.fund()` (no args) reads the budget straight from the
            // on-chain job and dispatches through the SubscriptionHook (and
            // FundTransferHook, if configured) automatically — no extra
            // arguments needed for subscription jobs.
            await session.fetchJob();
            await session.fund();
            log.job(session.jobId, `funded with ${proposedUsdc} USDC`);
          } catch (err) {
            log.error(`funding failed on job ${session.jobId}`, err);
          }
          break;
        }

        case "job.submitted":
          log.job(
            session.jobId,
            `deliverable received: ${entry.event.deliverable}`
          );
          log.job(session.jobId, "evaluating");

          // ▸ Reject point #2 — deliverable evaluation. Only fires when this
          //   wallet is the evaluator (we pass `evaluatorAddress: buyerAddress`
          //   below). Skip-evaluation mode auto-completes on submit.
          //
          //   if (!meetsExpectation(entry.event.deliverable)) {
          //     await session.sendMessage(
          //       "Deliverable does not match the requirement: <details>"
          //     );
          //     await session.reject("deliverable rejected");
          //     return;
          //   }

          try {
            await session.complete("Evaluated");
          } catch (err) {
            log.error(`completion failed on job ${session.jobId}`, err);
          }
          break;

        case "job.completed":
          log.job(session.jobId, "completed");
          log.info("---- transcript ----");
          console.log(await session.toContext());
          log.info("---- end transcript ----");
          await buyer.stop();
          break;

        case "job.rejected": {
          const role = counterpartyRole(session, entry.event.rejector);
          log.job(
            session.jobId,
            `rejected by ${role} ${shortAddr(entry.event.rejector)}: ${entry.event.reason}`
          );
          await buyer.stop();
          break;
        }

        case "job.expired":
          log.job(session.jobId, "expired");
          await buyer.stop();
          break;
      }
    }
  });

  await buyer.start();
  log.info("ready");

  const shutdown = async (signal: NodeJS.Signals) => {
    log.info(`received ${signal}, shutting down`);
    await buyer.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // ── Restart-safety check ─────────────────────────────────────────────
  // After `start()` the SDK has hydrated sessions for every active job
  // this wallet is on and re-fired the entry handler for the most recent
  // entry of each — so any in-flight resumption is already in motion.
  // We only need to decide whether to *also* create a NEW job alongside
  // the resuming one(s).
  const inFlight = buyer.sessions.filter(
    (s) =>
      s.chainId === chain.id &&
      s.roles.includes("client") &&
      !["completed", "rejected", "expired"].includes(s.status)
  );
  if (inFlight.length > 0) {
    log.info(
      `found ${inFlight.length} in-flight job(s) initiated by this wallet:`
    );
    for (const s of inFlight) {
      log.info(
        `  - job ${s.jobId} — status=${s.status}, provider ${shortAddr(
          s.job!.providerAddress
        )}`
      );
    }
    const createNew = await promptYesNo(
      "[buyer-sub] create another job in addition to the resuming one(s)? [y/N] ",
      false
    );
    if (!createNew) {
      log.info(
        "resuming existing job(s); not creating a new one — buyer will stop when the current job reaches a terminal state"
      );
      return;
    }
    log.info("user opted in: creating a new job alongside the resuming one(s)");
  }

  // 1. Look up the seller directly by wallet address. Subscription flows are
  //    typically deterministic (you know which provider owns the package),
  //    so we skip discovery and target the configured seller.
  const sellerAddress = requireEnv("SELLER_WALLET_ADDRESS");
  log.info(`looking up seller at ${sellerAddress}`);
  const agent = await buyer.getAgentByWalletAddress(sellerAddress);
  if (!agent) {
    log.error(`no agent registered at ${shortAddr(sellerAddress)}`);
    await buyer.stop();
    return;
  }
  log.info(
    `found provider ${shortAddr(agent.walletAddress)} with ${
      agent.offerings.length
    } offering(s)`
  );

  // 2. Pick an offering that has at least one subscription package attached.
  //    A non-subscription offering would cause `createJobFromOffering` to
  //    create a plain job (no SubscriptionHook), which is not what this
  //    example is demonstrating.
  const offering = agent.offerings.find(
    (o) => (o.subscriptions ?? []).length > 0
  );
  if (!offering) {
    log.error(
      `agent ${shortAddr(agent.walletAddress)} has no offerings with subscriptions`
    );
    await buyer.stop();
    return;
  }

  // 3. Pick a subscription package. The example takes the first one; in
  //    a real flow you'd choose by name/duration/price.
  const subscription = offering.subscriptions![0]!;
  log.info(
    `selected offering "${offering.name}" (${offering.priceValue} USDC, sla=${offering.slaMinutes}min) ` +
      `with subscription "${subscription.name}" (packageId=${subscription.packageId}, ` +
      `${subscription.price} USDC / ${subscription.duration}s)`
  );

  // 4. Create the subscription job. Passing `packageId` flips
  //    `createJobFromOffering` from a plain job to a SubscriptionHook job
  //    (or SubscriptionHook + FundTransferHook if `offering.requiredFunds`).
  const requirementData = {
    description: "Test request from subscription/buyer.ts example",
  };
  log.info(`requirement: ${JSON.stringify(requirementData)}`);

  try {
    const jobId = await buyer.createJobFromOffering(
      chain.id,
      offering,
      agent.walletAddress,
      requirementData,
      { evaluatorAddress: buyerAddress, packageId: subscription.packageId }
    );
    log.job(jobId.toString(), "created — waiting for seller");
  } catch (err) {
    log.error("createJobFromOffering failed", err);
    await buyer.stop();
  }
}

main().catch(console.error);
