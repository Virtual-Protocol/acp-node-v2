import { base } from "@account-kit/infra";
import dotenv from "dotenv";
import * as readline from "node:readline";
import {
  AcpAgent,
  PrivyAlchemyEvmProviderAdapter,
  type JobRoomEntry,
  type JobSession,
} from "../../index.js";
import {
  exampleClosePositionRequirement,
  exampleOpenPositionRequirement,
  exampleSwapTokenRequirement,
  JOB_CLOSE_POSITION,
  JOB_OPEN_POSITION,
  JOB_SWAP_TOKEN,
} from "./jobTypes.js";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// Fund-transfer buyer lifecycle (same event shape as `basic/buyer.ts`):
//
//   1. getAgentByWalletAddress()  → resolve provider
//   2. pick an offering           → must have requiredFunds (fund-transfer hook)
//   3. createJobFromOffering()    → validates requirement, creates job, sends
//                                   the first requirement message
//   4. budget.set                 → session.fetchJob(); session.fund()
//   5. job.submitted              → session.complete() (or reject())
//   6. job.completed              → transcript, buyer.stop()
//   7. job.rejected / job.expired → log, buyer.stop()
//
// Evaluation modes match `basic/buyer.ts` (self-eval via evaluatorAddress).
//
// Restart safety: same in-flight prompt as basic.
//
// Required env: BUYER_WALLET_ADDRESS, BUYER_WALLET_ID, BUYER_SIGNER_PRIVATE_KEY,
//   SELLER_WALLET_ADDRESS
// Optional: FUND_TRANSFER_OFFERING_NAME, FUND_TRANSFER_DEMO=plain|swap|open|close
// ---------------------------------------------------------------------------

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
  info: (m: string) => console.log(`[buyer-fund] ${m}`),
  job: (id: string | number, m: string) =>
    console.log(`[buyer-fund] [job ${id}] ${m}`),
  chat: (session: JobSession, from: string, content: string) =>
    console.log(
      `[buyer-fund] [job ${session.jobId}] ${counterpartyRole(
        session,
        from
      )} ${shortAddr(from)}: ${content}`
    ),
  send: (session: JobSession, content: string) =>
    console.log(`[buyer-fund] [job ${session.jobId}] me: ${content}`),
  warn: (m: string) => console.warn(`[buyer-fund] [warn] ${m}`),
  error: (m: string, e?: unknown) =>
    console.error(`[buyer-fund] [error] ${m}`, e ?? ""),
};

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
          const proposedUsdc = entry.event.amount;
          log.job(
            session.jobId,
            `proposed budget ${proposedUsdc} USDC`
          );
          try {
            log.send(session, "Looks good, funding now.");
            await session.sendMessage("Looks good, funding now.");
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
      "[buyer-fund] create another job in addition to the resuming one(s)? [y/N] ",
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

  const sellerWallet = requireEnv("SELLER_WALLET_ADDRESS");
  log.info(`looking up seller at ${sellerWallet}`);
  const agent = await buyer.getAgentByWalletAddress(sellerWallet);
  if (!agent) {
    log.error(`no agent registered at ${shortAddr(sellerWallet)}`);
    await buyer.stop();
    return;
  }

  const nameFilter = process.env.FUND_TRANSFER_OFFERING_NAME?.trim();
  const withFunds = agent.offerings.filter((o) => o.requiredFunds);
  const offering = nameFilter
    ? withFunds.find((o) => o.name === nameFilter)
    : withFunds[0];

  if (!offering) {
    log.error(
      nameFilter
        ? `no offering named "${nameFilter}" with requiredFunds=true`
        : "no offerings with requiredFunds=true on this agent"
    );
    await buyer.stop();
    return;
  }

  log.info(
    `selected offering "${offering.name}" (${offering.priceValue} USDC, requiredFunds=true, sla=${offering.slaMinutes}min)`
  );

  const demo = (process.env.FUND_TRANSFER_DEMO ?? "plain").toLowerCase();
  let requirementData: Record<string, unknown>;
  if (demo === "plain") {
    requirementData = {
      description: "Fund-transfer request",
      forwardUsdc: Number(
        process.env.FUND_TRANSFER_DEFAULT_FORWARD_USDC ?? "0.022"
      ),
    };
  } else if (demo === "swap" || demo === "open" || demo === "close") {
    const expectedName =
      demo === "swap"
        ? JOB_SWAP_TOKEN
        : demo === "open"
          ? JOB_OPEN_POSITION
          : JOB_CLOSE_POSITION;
    if (offering.name !== expectedName) {
      log.error(
        `FUND_TRANSFER_DEMO=${demo} requires an offering named "${expectedName}", got "${offering.name}"`
      );
      await buyer.stop();
      return;
    }
    requirementData =
      demo === "swap"
        ? { ...exampleSwapTokenRequirement }
        : demo === "open"
          ? { ...exampleOpenPositionRequirement }
          : { ...exampleClosePositionRequirement };
  } else {
    log.error(`Unknown FUND_TRANSFER_DEMO=${demo}`);
    await buyer.stop();
    return;
  }

  log.info(`requirement: ${JSON.stringify(requirementData)}`);

  try {
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
