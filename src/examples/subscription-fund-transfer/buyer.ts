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
// Subscription + fund-transfer buyer lifecycle:
//
//   Same on-chain flow as subscription/buyer.ts (browse/lookup → offering →
//   createJobFromOffering → fund on budget.set → complete on job.submitted),
//   with one extra constraint at offering selection:
//
//     • The chosen offering must have at least one `subscriptions` entry
//       AND `requiredFunds: true`. With `packageId` passed to
//       `createJobFromOffering`, the SDK creates a SubscriptionHook +
//       FundTransferHook multi-hook job (the seller side then uses
//       `setBudgetWithSubscriptionAndFundRequest`).
//
//     • The seller's setBudget bakes both the subscription fee (first job
//       only) and the fund-transfer intent (every job) into the proposal —
//       once the subscription is active, the budget drops to the
//       fund-transfer + offering portion only.
//
//   Funding: `session.fund()` (no args) detects the multi-hook config from
//   the on-chain job and dispatches through the right path automatically —
//   no extra work on the buyer side.
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
  info: (m: string) => console.log(`[buyer-sub-fund] ${m}`),
  job: (id: string | number, m: string) =>
    console.log(`[buyer-sub-fund] [job ${id}] ${m}`),
  chat: (session: JobSession, from: string, content: string) =>
    console.log(
      `[buyer-sub-fund] [job ${session.jobId}] ${counterpartyRole(
        session,
        from
      )} ${shortAddr(from)}: ${content}`
    ),
  send: (session: JobSession, content: string) =>
    console.log(`[buyer-sub-fund] [job ${session.jobId}] me: ${content}`),
  warn: (m: string) => console.warn(`[buyer-sub-fund] [warn] ${m}`),
  error: (m: string, e?: unknown) =>
    console.error(`[buyer-sub-fund] [error] ${m}`, e ?? ""),
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
          // still active. The fund-transfer amount is encoded separately in
          // the on-chain job's FundIntent — `session.fund()` settles both in
          // one call.
          const proposedUsdc = entry.event.amount;
          log.job(session.jobId, `proposed budget ${proposedUsdc} USDC`);

          // ▸ Reject point #1 — budget policy.
          //   First-job budgets include the subscription fee, so set the cap
          //   high enough to cover offering + subscription. After the
          //   subscription is active the budget should drop. Note the
          //   fund-transfer amount is NOT part of `proposedUsdc` — it's
          //   carried on the on-chain job's FundIntent and pulled from the
          //   buyer at fund() time on top of the budget.
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
            // `session.fund()` (no args) reads the budget AND the fund
            // intent from the on-chain job, then dispatches through the
            // SubscriptionHook + FundTransferHook multi-hook path
            // automatically — no extra arguments needed.
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
      "[buyer-sub-fund] create another job in addition to the resuming one(s)? [y/N] ",
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

  // 2. Pick an offering that has BOTH a subscription package AND
  //    `requiredFunds: true`. That combination is what flips
  //    `createJobFromOffering` into a SubscriptionHook + FundTransferHook
  //    multi-hook job — the whole point of this example.
  const offering = agent.offerings.find(
    (o) => o.requiredFunds && (o.subscriptions ?? []).length > 0
  );
  if (!offering) {
    log.error(
      `agent ${shortAddr(agent.walletAddress)} has no offerings with both requiredFunds=true and a subscription package`
    );
    await buyer.stop();
    return;
  }

  // 3. Pick a subscription package. The example takes the first one; in
  //    a real flow you'd choose by name/duration/price.
  const subscription = offering.subscriptions![0]!;
  log.info(
    `selected offering "${offering.name}" (${offering.priceValue} USDC, requiredFunds=true, sla=${offering.slaMinutes}min) ` +
      `with subscription "${subscription.name}" (packageId=${subscription.packageId}, ` +
      `${subscription.price} USDC / ${subscription.duration}s)`
  );

  // 4. Create the subscription + fund-transfer job. Passing `packageId`
  //    plus an offering with `requiredFunds: true` flips
  //    `createJobFromOffering` into a SubscriptionHook + FundTransferHook
  //    multi-hook job. The seller side will respond with
  //    `setBudgetWithSubscriptionAndFundRequest`.
  const requirementData = {
    description:
      "Test request from subscription-fund-transfer/buyer.ts example",
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
