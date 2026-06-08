import { AcpAgent } from "../../acpAgent.js";
import { AssetToken } from "../../core/assetToken.js";
import { base } from "@account-kit/infra";
import dotenv from "dotenv";
import { PrivyAlchemyEvmProviderAdapter } from "../../providers/evm/privyAlchemyEvmProviderAdapter.js";
import {
  type AcpAgentOffering,
  type JobRoomEntry,
  type JobSession,
} from "../../index.js";
import {
  EXAMPLE_SDK_JOB_DESCRIPTION,
  JOB_CLOSE_POSITION,
  JOB_OPEN_POSITION,
  JOB_SWAP_TOKEN,
  parseClosePositionPayload,
  parseOpenPositionPayload,
  parseSwapPayload,
} from "./jobTypes.js";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// Fund-transfer seller lifecycle (event-driven `entry`, like `basic/seller.ts`):
//
//   job.created          → log
//   requirement message  → session.setBudgetWithFundRequest(...) — required
//                          whenever FundTransferHook is configured (cannot use
//                          setBudget alone; see JobSession.setBudget).
//   budget.set           → buyer funds
//   job.funded           → session.submit(...)
//   job.completed        → transcript
//
// Reject points match basic: malformed requirement, unknown offering, or
// offering without requiredFunds when using the registry path.
//
// Routing:
//   • Registry: job.description matches an offering name → budget from
//     offering.priceValue; forward slice from requirement.forwardUsdc or env.
//   • Structured samples: job.description is swap_token, open_position, or
//     close_position with no registry row → amounts from parsed requirement and env.
//   • Doc snippet: job.description matches EXAMPLE_SDK_JOB_DESCRIPTION (or
//     FUND_TRANSFER_EXAMPLE_JOB_DESCRIPTION) → budget and forward from
//     FUND_TRANSFER_EXAMPLE_* env vars.
// ---------------------------------------------------------------------------

const chain = base;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
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
  info: (m: string) => console.log(`[seller-fund] ${m}`),
  job: (id: string | number, m: string) =>
    console.log(`[seller-fund] [job ${id}] ${m}`),
  chat: (session: JobSession, from: string, content: string) =>
    console.log(
      `[seller-fund] [job ${session.jobId}] ${counterpartyRole(
        session,
        from
      )} ${shortAddr(from)}: ${content}`
    ),
  send: (session: JobSession, content: string) =>
    console.log(`[seller-fund] [job ${session.jobId}] me: ${content}`),
  warn: (m: string) => console.warn(`[seller-fund] [warn] ${m}`),
  error: (m: string, e?: unknown) =>
    console.error(`[seller-fund] [error] ${m}`, e ?? ""),
};

function formatRequirement(r: unknown): string {
  return typeof r === "string" ? r : JSON.stringify(r);
}

/** Forward slice for structured sample kinds when not set on the requirement. */
const structuredSampleForwardUsdc = (): number =>
  Number(process.env.FUND_TRANSFER_STRUCTURED_FORWARD_USDC ?? "0.022");

function readForwardFromRequirement(
  requirementData: unknown,
  fallback: number
): number {
  if (!requirementData || typeof requirementData !== "object") return fallback;
  const o = requirementData as Record<string, unknown>;
  const v = o.forwardUsdc ?? o.transferUsdc;
  return typeof v === "number" && !Number.isNaN(v) ? v : fallback;
}

async function main(): Promise<void> {
  const seller = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: requireEnv("SELLER_WALLET_ADDRESS") as `0x${string}`,
      walletId: requireEnv("SELLER_WALLET_ID"),
      signerPrivateKey: requireEnv("SELLER_SIGNER_PRIVATE_KEY"),
      chains: [chain],
    }),
  });

  const sellerAddress = (await seller.getAddress()) as `0x${string}`;
  const sellerAddressLower = sellerAddress.toLowerCase();
  log.info(`address: ${sellerAddressLower}`);

  const dest =
    (process.env.FUND_TRANSFER_DESTINATION as `0x${string}` | undefined) ??
    sellerAddress;

  let offeringsByName = new Map<string, AcpAgentOffering>();
  try {
    const me = await seller.getAgentByWalletAddress(sellerAddressLower);
    offeringsByName = new Map(
      (me?.offerings ?? []).map((o) => [o.name, o] as const)
    );
    log.info(`loaded ${offeringsByName.size} offering(s):`);
    for (const o of offeringsByName.values()) {
      log.info(
        `  - ${o.name}: ${o.priceValue} USDC (requiredFunds=${o.requiredFunds}, sla=${o.slaMinutes}min)`
      );
    }
  } catch (err) {
    log.warn(
      `registry offerings unavailable; only structured sample kinds and default direct description are supported: ${err}`
    );
  }

  seller.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (
      entry.kind === "message" &&
      entry.from.toLowerCase() !== sellerAddressLower &&
      entry.contentType !== "requirement"
    ) {
      log.chat(session, entry.from, entry.content);
    }

    if (entry.kind === "system") {
      switch (entry.event.type) {
        case "job.created":
          log.job(
            session.jobId,
            `new job received from buyer ${shortAddr(entry.event.client)}`
          );
          break;

        case "job.funded":
          log.job(session.jobId, "funded, delivering");
          try {
            log.send(session, "Got the funds. Working on it now.");
            await session.sendMessage("Got the funds. Working on it now.");
            await session.submit("Test deliverable");
            log.job(session.jobId, "submitted deliverable");
          } catch (err) {
            log.error(`delivery failed on job ${session.jobId}`, err);
          }
          break;

        case "job.completed":
          log.job(session.jobId, "completed");
          log.info("---- transcript ----");
          console.log(await session.toContext());
          log.info("---- end transcript ----");
          break;

        case "job.rejected": {
          const role = counterpartyRole(session, entry.event.rejector);
          log.job(
            session.jobId,
            `rejected by ${role} ${shortAddr(entry.event.rejector)}: ${entry.event.reason}`
          );
          break;
        }

        case "job.expired":
          log.job(session.jobId, "expired");
          break;
      }
    }

    if (
      entry.kind === "message" &&
      entry.contentType === "requirement" &&
      session.status === "open"
    ) {
      const rejectWithDetail = async (
        tag: string,
        detail: string
      ): Promise<void> => {
        log.job(session.jobId, `rejecting (${tag}): ${detail}`);
        await session.sendMessage(detail);
        await session.reject(tag);
      };

      const offeringName = session.job?.description;
      if (!offeringName) {
        await rejectWithDetail(
          "missing offering name",
          "Job description is empty; cannot identify offering"
        );
        return;
      }

      let requirementData: unknown;
      try {
        requirementData = JSON.parse(entry.content);
      } catch (err) {
        await rejectWithDetail(
          "unparseable requirement",
          `Could not parse requirement payload: ${err}`
        );
        return;
      }

      log.job(
        session.jobId,
        `received requirement for "${offeringName}": ${formatRequirement(
          requirementData
        )}`
      );

      const defaultForward = Number(
        process.env.FUND_TRANSFER_DEFAULT_FORWARD_USDC ?? "0.022"
      );
      const exampleJobDescription =
        process.env.FUND_TRANSFER_EXAMPLE_JOB_DESCRIPTION?.trim() ||
        EXAMPLE_SDK_JOB_DESCRIPTION;

      const exampleBudgetUsdc = Number(
        process.env.FUND_TRANSFER_EXAMPLE_BUDGET_USDC ?? "0.1"
      );
      const exampleForwardUsdc = Number(
        process.env.FUND_TRANSFER_EXAMPLE_FORWARD_USDC ?? "0.022"
      );

      const offering = offeringsByName.get(offeringName);

      try {
        // Registry-backed fund-transfer offering
        if (offering) {
          if (!offering.requiredFunds) {
            await rejectWithDetail(
              "offering not fund-transfer",
              `Offering "${offering.name}" has requiredFunds=false; use a fund-transfer offering or the basic example for plain jobs`
            );
            return;
          }
          const forward = readForwardFromRequirement(
            requirementData,
            defaultForward
          );
          log.job(
            session.jobId,
            `registry "${offering.name}": budget ${offering.priceValue} USDC, forward ${forward} USDC to ${shortAddr(dest)}`
          );
          await session.setBudgetWithFundRequest(
            AssetToken.usdc(offering.priceValue, session.chainId),
            AssetToken.usdc(forward, session.chainId),
            dest
          );
          log.job(
            session.jobId,
            `set budget with fund request (${offering.priceValue} / ${forward} USDC)`
          );
          return;
        }

        // Structured sample kinds (no registry row)
        if (offeringName === JOB_SWAP_TOKEN) {
          const p = parseSwapPayload(requirementData);
          if (!p) {
            await rejectWithDetail(
              "invalid swap payload",
              "Requirement does not match the expected swap_token JSON shape"
            );
            return;
          }
          const fwd = structuredSampleForwardUsdc();
          const budget = Math.max(p.amount, fwd + 0.01);
          await session.setBudgetWithFundRequest(
            AssetToken.usdc(budget, session.chainId),
            AssetToken.usdc(fwd, session.chainId),
            dest
          );
          log.job(session.jobId, `swap_token: budget ${budget}, forward ${fwd}`);
          return;
        }

        if (offeringName === JOB_OPEN_POSITION) {
          const p = parseOpenPositionPayload(requirementData);
          if (!p) {
            await rejectWithDetail(
              "invalid open_position payload",
              "Requirement does not match the expected open_position JSON shape"
            );
            return;
          }
          const fwd = structuredSampleForwardUsdc();
          const budget = Math.max(p.amount, fwd + 0.01);
          await session.setBudgetWithFundRequest(
            AssetToken.usdc(budget, session.chainId),
            AssetToken.usdc(fwd, session.chainId),
            dest
          );
          log.job(
            session.jobId,
            `open_position: budget ${budget}, forward ${fwd}`
          );
          return;
        }

        if (offeringName === JOB_CLOSE_POSITION) {
          const p = parseClosePositionPayload(requirementData);
          if (!p) {
            await rejectWithDetail(
              "invalid close_position payload",
              "Requirement does not match the expected close_position JSON shape"
            );
            return;
          }
          const budget = Math.max(
            0.01,
            Number(process.env.FUND_TRANSFER_CLOSE_BUDGET_USDC ?? "0.02")
          );
          await session.setBudgetWithFundRequest(
            AssetToken.usdc(budget, session.chainId),
            AssetToken.usdc(0, session.chainId),
            dest
          );
          log.job(
            session.jobId,
            `close_position (${p.symbol}): budget ${budget}, forward 0`
          );
          return;
        }

        // Documentation example job description (see EXAMPLE_SDK_JOB_DESCRIPTION)
        if (offeringName === exampleJobDescription) {
          await session.setBudgetWithFundRequest(
            AssetToken.usdc(exampleBudgetUsdc, session.chainId),
            AssetToken.usdc(exampleForwardUsdc, session.chainId),
            dest
          );
          log.job(
            session.jobId,
            `example job amounts: budget ${exampleBudgetUsdc}, forward ${exampleForwardUsdc}`
          );
          return;
        }

        await rejectWithDetail(
          "unsupported offering",
          `No registry offering and unknown job description "${offeringName}"`
        );
      } catch (err) {
        log.error(`setBudgetWithFundRequest failed on job ${session.jobId}`, err);
      }
    }
  });

  await seller.start();
  log.info("ready, listening for jobs");

  const shutdown = async (signal: NodeJS.Signals) => {
    log.info(`received ${signal}, shutting down`);
    await seller.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(console.error);
