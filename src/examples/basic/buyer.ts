import { base } from "@account-kit/infra";
import dotenv from "dotenv";
import * as readline from "node:readline";
import {
  AcpAgent,
  AgentSort,
  PrivyAlchemyEvmProviderAdapter,
  type JobRoomEntry,
  type JobSession,
} from "../../index.js";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// Buyer lifecycle:
//
//   1. browseAgents()           → find a provider by keyword
//   2. pick an offering         → defines the requirement schema and SLA
//   3. createJobFromOffering()  → validates requirement, creates on-chain job,
//                                 sends the first "requirement" message
//   4. budget.set               → call session.fund()  (or session.reject())
//   5. job.submitted            → call session.complete() (or session.reject())
//   6. job.completed            → print transcript and buyer.stop()
//   7. job.rejected             → log reason and buyer.stop()
//   8. job.expired              → log and buyer.stop() (deadline passed)
//
// Evaluation modes (chosen via `opts.evaluatorAddress` on createJobFromOffering):
//
//   • Self-evaluation     — `evaluatorAddress: buyerAddress` (this example).
//                           The buyer also acts as evaluator: case "job.submitted"
//                           fires here, the buyer calls session.complete()/reject().
//
//   • Third-party eval    — `evaluatorAddress: <other wallet>`. The buyer
//                           only sees `job.completed`/`job.rejected`; an
//                           independent process on the evaluator wallet must
//                           handle `case "job.submitted"`.
//
//   • Skip evaluation     — omit `evaluatorAddress` (defaults to zero address).
//                           The contract auto-completes the job on submit:
//                           the lifecycle skips `job.submitted` entirely and
//                           goes `budget.set` → `job.funded` → `job.completed`.
//                           Use only with trusted providers — there's no
//                           quality gate between submission and payout.
//
// Restart safety:
//   On startup the SDK calls AcpJobApi.getActiveJobs() and rebuilds sessions
//   for every in-flight job this wallet participated in, then fires the
//   `entry` handler for the most recent entry of each. So if you Ctrl+C the
//   buyer at `budget.set`, restarting it will hydrate the session, replay
//   the `budget.set` event, and call `session.fund()` again — funding picks
//   up exactly where it left off. Same for `job.submitted` → evaluation.
//
//   Below we filter `buyer.sessions` for non-terminal client-role sessions
//   and prompt before creating a NEW job, so a restart doesn't silently
//   pile on extra on-chain jobs alongside the resuming one.
//
// Reject points (see inline ▸ markers):
//   • budget.set    — refuse if the proposed budget exceeds policy
//   • job.submitted — refuse if the deliverable doesn't meet expectations
//                     (only when this buyer is also the evaluator)
//
// Required env vars (see .env.example):
//   BUYER_WALLET_ADDRESS, BUYER_WALLET_ID, BUYER_SIGNER_PRIVATE_KEY
// ---------------------------------------------------------------------------

const shortAddr = (a: string): string =>
  !a || !a.startsWith("0x") || a.length < 12
    ? a
    : `${a.slice(0, 6)}…${a.slice(-4)}`;

// `session.job` is populated by the SDK before the entry handler fires (both
// at hydration time and on live dispatch), so we can read the canonical role
// addresses straight off the loaded job rather than scanning history.
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
  info: (m: string) => console.log(`[buyer] ${m}`),
  job: (id: string | number, m: string) =>
    console.log(`[buyer] [job ${id}] ${m}`),
  chat: (session: JobSession, from: string, content: string) =>
    console.log(
      `[buyer] [job ${session.jobId}] ${counterpartyRole(
        session,
        from
      )} ${shortAddr(from)}: ${content}`
    ),
  send: (session: JobSession, content: string) =>
    console.log(`[buyer] [job ${session.jobId}] me: ${content}`),
  warn: (m: string) => console.warn(`[buyer] [warn] ${m}`),
  error: (m: string, e?: unknown) =>
    console.error(`[buyer] [error] ${m}`, e ?? ""),
};

const chain = base;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Tiny y/N prompt over readline. Honours the default when the user hits
// enter, and falls back to the default automatically when stdin isn't a TTY
// (CI, piped input) so the example doesn't hang in non-interactive contexts.
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
          // The budget amount the seller proposed is on the event itself —
          // no need to hardcode or fetch separately for visibility.
          const proposedUsdc = entry.event.amount;
          log.job(
            session.jobId,
            `proposed budget ${proposedUsdc} USDC`
          );

          // ▸ Reject point #1 — budget policy.
          //   The buyer can refuse the job here if the proposed budget is
          //   above what they're willing to pay. After `session.reject(...)`
          //   the job ends and `case "job.rejected"` will fire on both sides.
          //   For richer context, send a `sendMessage(...)` first and reject
          //   with a short tag.
          //
          //   const MAX_USDC = 1.0;
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
            // on-chain job and also handles the optional FundIntent for
            // fund-transfer jobs. It needs `fetchJob()` first to load the
            // off-chain job record.
            await session.fetchJob();
            await session.fund();
            log.job(
              session.jobId,
              `funded with ${proposedUsdc} USDC`
            );
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

          // ▸ Reject point #2 — deliverable evaluation.
          //   This branch only fires when this wallet is the evaluator —
          //   i.e. the buyer used `evaluatorAddress: buyerAddress` (this
          //   example). For third-party-eval jobs it fires on the evaluator
          //   process instead, and for skip-evaluation jobs (zero-address
          //   evaluator) it doesn't fire at all — the contract jumps
          //   straight to `job.completed` on submit.
          //
          //   If the deliverable doesn't meet the requirement, reject
          //   instead of completing — funds are returned to the buyer.
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

  // Cleanup on early termination. The happy path shutdown happens in the
  // `job.completed` branch above; this only fires if the user Ctrl+Cs while
  // a job is mid-flight.
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
  // entry of each — so any in-flight resumption (funding a budget-set job,
  // evaluating a submitted job) is already in motion in the background.
  //
  // We only need to decide whether to *also* create a NEW job alongside
  // the resuming one(s). Default: no — restarting should not silently
  // pile on more on-chain jobs.
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
      "[buyer] create another job in addition to the resuming one(s)? [y/N] ",
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

  // 1. Resolve the provider agent. Two options:
  //
  //    (a) Discovery — browse the registry by keyword. Best when you don't
  //        know the seller in advance and want to pick by reputation/rating.
  //
  //    (b) Direct lookup — fetch a known seller by wallet address. Best for
  //        deterministic flows (tests, fixed integrations, your own seller).
  //
  //    Both return the same `AcpAgentDetail` shape, so the rest of the flow
  //    (offering selection + createJobFromOffering) is identical.

  // (a) Discovery via browseAgents — replace the placeholder query with one
  //     that matches the seller you've registered (e.g. offering tag or name).
  // const agents = await buyer.browseAgents("<search query>", {
  //   sortBy: [AgentSort.SUCCESSFUL_JOB_COUNT, AgentSort.SUCCESS_RATE],
  //   topK: 5,
  //   showHidden: true,
  // });

  // const agent = agents[0];
  // if (!agent) {
  //   log.error("no agents found matching the search query");
  //   await buyer.stop();
  //   return;
  // }

  // (b) Direct lookup — uncomment and remove the browseAgents block above to
  //     target a specific seller by wallet address (e.g. from `SELLER_WALLET_ADDRESS`
  //     in your .env). Returns null if the wallet isn't registered.
  //
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

  // 2. Select an offering
  const offering = agent.offerings[0];
  if (!offering) {
    log.error(`agent ${shortAddr(agent.walletAddress)} has no offerings`);
    await buyer.stop();
    return;
  }
  log.info(
    `selected offering "${offering.name}" (${offering.priceValue} USDC, sla=${offering.slaMinutes}min)`
  );

  // 3. Create job from offering — validates requirement against the offering's
  //    JSON schema, creates the on-chain job (expiredAt = now + offering.slaMinutes,
  //    description = offering.name), and sends the first message with the bare
  //    `requirementData` JSON body (contentType="requirement"). The seller
  //    reads the offering name from the on-chain `description` via
  //    `session.job.description` rather than from the message envelope.
  //
  //    Replace `requirementData` with whatever shape `offering.requirements`
  //    expects. Inspect via `console.log(offering.requirements)` if unsure.
  const requirementData = {
    description: "Test request from buyer.ts example",
  };
  log.info(`requirement: ${JSON.stringify(requirementData)}`);

  try {
    // `evaluatorAddress: buyerAddress` selects **self-evaluation**: this
    // buyer also gates the deliverable. Two alternatives, see the JSDoc on
    // `createJobFromOffering`:
    //   • Third-party eval — pass a different wallet address. That wallet
    //     must run its own agent process to handle `case "job.submitted"`.
    //   • Skip evaluation — omit the field entirely. The contract treats a
    //     zero-address evaluator as "no evaluator" and auto-completes the
    //     job on submit. No quality gate; only safe with trusted providers.
    const jobId = await buyer.createJobFromOffering(
      chain.id,
      offering,
      agent.walletAddress,
      requirementData,
      { evaluatorAddress: buyerAddress }
    );
    log.job(jobId.toString(), "created — waiting for seller");
  } catch (err) {
    log.error("createJobFromOffering failed", err);
    await buyer.stop();
  }
}

main().catch(console.error);
