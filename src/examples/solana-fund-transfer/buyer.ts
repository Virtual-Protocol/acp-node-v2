import dotenv from "dotenv";
import * as readline from "node:readline";
import {
  AcpAgent,
  AcpApiClient,
  PrivySolanaProviderAdapter,
  SseTransport,
  type JobRoomEntry,
  type JobSession,
  ACP_SERVER_URL,
  PRIVY_APP_ID,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_NO_EVALUATOR_ADDRESS,
} from "../../index.js";
import {
  exampleClosePositionRequirement,
  exampleOpenPositionRequirement,
  exampleSwapTokenRequirement,
  JOB_CLOSE_POSITION,
  JOB_OPEN_POSITION,
  JOB_SWAP_TOKEN,
} from "../fund-transfer/jobTypes.js";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// Solana fund-transfer buyer — the fund-transfer flow from
// src/examples/fund-transfer/buyer.ts, but the agent is backed by a Solana
// client (`solanaProvider`) instead of an EVM one (same Solana wiring as
// src/examples/solana-basic/buyer.ts).
//
// Fund-transfer jobs split the buyer's funded amount: part pays the seller
// (the budget), part is forwarded to a separate on-chain destination on
// submission. The buyer only has to pick an offering where `requiredFunds` is
// true — the SDK selects the fund-transfer hook on-chain — and fund it. The
// split itself (`setBudgetWithFundRequest`) is the seller's responsibility.
//
// Buyer lifecycle (identical event shape to solana-basic/buyer.ts):
//
//   1. getAgentByWalletAddress()  → resolve provider
//   2. pick an offering           → must have `requiredFunds` (fund-transfer)
//   3. createJobFromOffering()    → validates requirement, creates the on-chain
//                                   job, sends the first "requirement" message
//   4. budget.set                 → session.fetchJob(); session.fund()
//   5. job.submitted              → session.complete() (or session.reject())
//   6. job.completed              → print transcript and buyer.stop()
//   7. job.rejected / job.expired → log and buyer.stop()
//
// This example self-evaluates (`evaluatorAddress: buyerAddress`): `case
// "job.submitted"` fires here and the buyer gates the deliverable. For the
// other evaluation modes (third-party / skip-evaluation) see the JSDoc on
// `createJobFromOffering` and the notes in solana-basic/buyer.ts.
//
// Restart safety mirrors solana-basic: on startup the SDK hydrates sessions
// for every in-flight job this wallet is on and re-fires the entry handler, so
// a Ctrl+C at `budget.set` resumes funding on restart. Below we prompt before
// creating a NEW job so a restart doesn't pile on extra on-chain jobs.
//
// Solana specifics (see solana-basic/buyer.ts for the full rationale):
//   • chainId 500 = devnet, 501 = mainnet-beta (SOLANA_*_CHAIN_ID) — ACP's
//     internal Solana chain ids, not EVM chain ids.
//   • Wallet addresses are base58 (no `0x` prefix) and case-sensitive.
//   • Solana runs against the ACP dev/testnet backend (ACP_TESTNET_SERVER_URL);
//     production does not expose the Solana signing proxy. The URL is wired into
//     the provider, the AcpApiClient, and the SseTransport. `privyAppId`,
//     backend, and wallet must all reference the same environment — override
//     with SOLANA_PRIVY_APP_ID if the default doesn't match the live dev
//     deployment.
//
// Demo requirement shapes (FUND_TRANSFER_DEMO):
//   • plain (default) → { description, forwardUsdc } — the seller reads
//     `forwardUsdc` for the forward slice. This is the core fund-transfer path.
//   • swap | open | close → structured bodies from fund-transfer/jobTypes.ts,
//     requiring a seller offering named swap_token / open_position /
//     close_position. NOTE: those sample bodies carry EVM (Base) sample token
//     addresses; they're kept here for parity with the EVM example and need a
//     Solana seller that understands them. For testing the Solana fund-transfer
//     flow, `plain` is the mode you want.
//
// Required env vars (see .env.example):
//   SOLANA_BUYER_WALLET_ADDRESS, SOLANA_BUYER_WALLET_ID,
//   SOLANA_BUYER_SIGNER_PRIVATE_KEY, SOLANA_SELLER_WALLET_ADDRESS
// Optional:
//   SOLANA_PRIVY_APP_ID, FUND_TRANSFER_OFFERING_NAME,
//   FUND_TRANSFER_DEMO=plain|swap|open|close, FUND_TRANSFER_DEFAULT_FORWARD_USDC
// ---------------------------------------------------------------------------

// Solana addresses are base58 (no `0x` prefix); just trim the middle.
const shortAddr = (a: string): string =>
  !a || a.length < 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;

// `session.job` is populated by the SDK before the entry handler fires, so we
// read the canonical role addresses straight off the loaded job. Compare
// case-sensitively — base58 is case-sensitive, unlike EVM hex.
const counterpartyRole = (session: JobSession, addr: string): string => {
  const job = session.job;
  if (!job) return "peer";
  if (job.clientAddress === addr) return "client";
  if (job.providerAddress === addr) return "provider";
  if (job.evaluatorAddress === addr) return "evaluator";
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
        from,
      )} ${shortAddr(from)}: ${content}`,
    ),
  send: (session: JobSession, content: string) =>
    console.log(`[buyer-fund] [job ${session.jobId}] me: ${content}`),
  warn: (m: string) => console.warn(`[buyer-fund] [warn] ${m}`),
  error: (m: string, e?: unknown) =>
    console.error(`[buyer-fund] [error] ${m}`, e ?? ""),
};

const chainId = SOLANA_MAINNET_CHAIN_ID;
const serverUrl = ACP_SERVER_URL;
const privyAppId = PRIVY_APP_ID;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Tiny y/N prompt over readline. Honours the default when the user hits enter,
// and falls back to the default automatically when stdin isn't a TTY (CI, piped
// input) so the example doesn't hang in non-interactive contexts.
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
    solanaProvider: await PrivySolanaProviderAdapter.create({
      walletAddress: requireEnv("SOLANA_BUYER_WALLET_ADDRESS"),
      walletId: requireEnv("SOLANA_BUYER_WALLET_ID"),
      signerPrivateKey: requireEnv("SOLANA_BUYER_SIGNER_PRIVATE_KEY"),
      chainId,
      serverUrl,
      privyAppId,
    }),
    transport: new SseTransport({ serverUrl }),
    api: new AcpApiClient({ serverUrl }),
  });

  const buyerAddress = await buyer.getAddress();
  log.info(`address: ${buyerAddress}`);

  buyer.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind === "message" && entry.from !== buyerAddress) {
      log.chat(session, entry.from, entry.content);
    }

    if (entry.kind === "system") {
      switch (entry.event.type) {
        case "budget.set": {
          // The budget amount the seller proposed is on the event itself. For a
          // fund-transfer job the seller set it via `setBudgetWithFundRequest`,
          // so the on-chain job also carries a FundIntent; `session.fund()`
          // (no args) reads both straight off the job after `fetchJob()`.
          const proposedUsdc = entry.event.amount;
          log.job(session.jobId, `proposed budget ${proposedUsdc} USDC`);
          try {
            log.send(session, "Looks good, funding now.");
            await session.sendMessage("Looks good, funding now.");
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
            `deliverable received: ${entry.event.deliverable}`,
          );
          log.job(session.jobId, "evaluating");

          // ▸ Reject point — deliverable evaluation. This branch fires because
          //   this wallet is the evaluator (`evaluatorAddress: buyerAddress`).
          //   Reject instead of completing if the deliverable doesn't meet the
          //   requirement — funds are returned to the buyer.
          //
          //   if (!meetsExpectation(entry.event.deliverable)) {
          //     await session.sendMessage("Deliverable does not match: <details>");
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
            `rejected by ${role} ${shortAddr(entry.event.rejector)}: ${entry.event.reason}`,
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
  // After start() the SDK has hydrated sessions for every active job this
  // wallet is on and re-fired the entry handler, so any in-flight resumption
  // (funding a budget-set job, evaluating a submitted job) is already in motion.
  // We only decide whether to *also* create a NEW job. Default: no.
  const inFlight = buyer.sessions.filter(
    (s) =>
      s.chainId === chainId &&
      s.roles.includes("client") &&
      !["completed", "rejected", "expired"].includes(s.status),
  );
  if (inFlight.length > 0) {
    log.info(
      `found ${inFlight.length} in-flight job(s) initiated by this wallet:`,
    );
    for (const s of inFlight) {
      log.info(
        `  - job ${s.jobId} — status=${s.status}, provider ${shortAddr(
          s.job!.providerAddress,
        )}`,
      );
    }
    const createNew = await promptYesNo(
      "[buyer-fund] create another job in addition to the resuming one(s)? [y/N] ",
      false,
    );
    if (!createNew) {
      log.info(
        "resuming existing job(s); not creating a new one — buyer will stop when the current job reaches a terminal state",
      );
      return;
    }
    log.info("user opted in: creating a new job alongside the resuming one(s)");
  }

  // 1. Resolve the provider agent by wallet address (deterministic lookup).
  const sellerAddress = requireEnv("SOLANA_SELLER_WALLET_ADDRESS");
  log.info(`looking up seller at ${sellerAddress}`);
  const agent = await buyer.getAgentByWalletAddress(sellerAddress);
  if (!agent) {
    log.error(`no agent registered at ${shortAddr(sellerAddress)}`);
    await buyer.stop();
    return;
  }
  log.info(
    `found provider ${shortAddr(agent.solWalletAddress)} with ${
      agent.offerings.length
    } offering(s)`,
  );

  // 2. Select a fund-transfer offering — one where `requiredFunds` is true.
  //    Optionally pin it by name via FUND_TRANSFER_OFFERING_NAME; otherwise the
  //    first `requiredFunds` offering is used.
  const nameFilter = process.env.FUND_TRANSFER_OFFERING_NAME?.trim();
  const withFunds = agent.offerings.filter((o) => o.requiredFunds);
  const offering = nameFilter
    ? withFunds.find((o) => o.name === nameFilter)
    : withFunds[0];
  if (!offering) {
    log.error(
      nameFilter
        ? `no offering named "${nameFilter}" with requiredFunds=true`
        : "no offerings with requiredFunds=true on this agent",
    );
    await buyer.stop();
    return;
  }
  log.info(
    `selected offering "${offering.name}" (${offering.priceValue} USDC, requiredFunds=true, sla=${offering.slaMinutes}min)`,
  );

  // 3. Shape the requirement body from FUND_TRANSFER_DEMO. `plain` (the default)
  //    is the core fund-transfer path; the structured modes need a matching
  //    offering name and a seller that parses them.
  const demo = (process.env.FUND_TRANSFER_DEMO ?? "plain").toLowerCase();
  let requirementData: Record<string, unknown>;
  if (demo === "plain") {
    requirementData = {
      description: "Solana fund-transfer request",
      forwardUsdc: Number(
        process.env.FUND_TRANSFER_DEFAULT_FORWARD_USDC ?? "0.022",
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
        `FUND_TRANSFER_DEMO=${demo} requires an offering named "${expectedName}", got "${offering.name}"`,
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

  // 4. Create the job from the offering. `evaluatorAddress: buyerAddress`
  //    selects self-evaluation so `case "job.submitted"` fires here. See
  //    solana-basic/buyer.ts for third-party / skip-evaluation alternatives.
  try {
    const jobId = await buyer.createJobFromOffering(
      chainId,
      offering,
      agent.solWalletAddress,
      requirementData,
      { evaluatorAddress: SOLANA_NO_EVALUATOR_ADDRESS },
    );
    log.job(jobId.toString(), "created — waiting for seller");
  } catch (err) {
    log.error("createJobFromOffering failed", err);
    await buyer.stop();
  }
}

main().catch(console.error);
