import { base } from "@account-kit/infra";
import dotenv from "dotenv";
import {
  AcpAgent,
  AssetToken,
  PrivyAlchemyEvmProviderAdapter,
  type AcpAgentOffering,
  type JobRoomEntry,
  type JobSession,
} from "../../index";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// Seller lifecycle (state machine driven by `entry` events):
//
//   job.created                → wait for buyer's requirement message
//   message(contentType=...)   → call session.setBudget() (or session.reject())
//   budget.set                 → wait for buyer to fund
//   job.funded                 → deliver via session.submit() (or session.reject())
//   job.completed              → done; session.toContext() has the transcript
//   job.rejected               → log reason; session is terminal
//   job.expired                → log; session is terminal (deadline passed)
//
// Reject points (see inline ▸ markers):
//   • requirement message — refuse if the request is out of capability
//                           (unknown offering, malformed requirement, …)
//   • job.funded          — refuse if you can no longer deliver
//                           (rare; capability concerns usually surface earlier)
//
// Required env vars (see .env.example):
//   SELLER_WALLET_ADDRESS, SELLER_WALLET_ID, SELLER_SIGNER_PRIVATE_KEY
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
  info: (m: string) => console.log(`[seller] ${m}`),
  job: (id: string | number, m: string) =>
    console.log(`[seller] [job ${id}] ${m}`),
  chat: (session: JobSession, from: string, content: string) =>
    console.log(
      `[seller] [job ${session.jobId}] ${counterpartyRole(
        session,
        from
      )} ${shortAddr(from)}: ${content}`
    ),
  send: (session: JobSession, content: string) =>
    console.log(`[seller] [job ${session.jobId}] me: ${content}`),
  warn: (m: string) => console.warn(`[seller] [warn] ${m}`),
  error: (m: string, e?: unknown) =>
    console.error(`[seller] [error] ${m}`, e ?? ""),
};

function formatRequirement(r: unknown): string {
  return typeof r === "string" ? r : JSON.stringify(r);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const seller = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: requireEnv("SELLER_WALLET_ADDRESS") as `0x${string}`,
      walletId: requireEnv("SELLER_WALLET_ID"),
      signerPrivateKey: requireEnv("SELLER_SIGNER_PRIVATE_KEY"),
      chains: [base],
    }),
  });

  const sellerAddress = (await seller.getAddress()).toLowerCase();
  log.info(`address: ${sellerAddress}`);

  // Fetch our own registry record once at startup and index offerings by name.
  // The buyer's "requirement" message carries `name: offering.name`, so we can
  // look up the price set on the registry instead of hardcoding it.
  //
  // Tradeoff: this snapshots the price at startup. If you frequently update
  // offering prices on the registry and want the seller to pick them up
  // without a restart, move the lookup inline (call `getAgentByWalletAddress`
  // each time a requirement arrives).
  let offeringsByName = new Map<string, AcpAgentOffering>();
  try {
    const me = await seller.getAgentByWalletAddress(sellerAddress);
    offeringsByName = new Map(
      (me?.offerings ?? []).map((o) => [o.name, o] as const)
    );
    log.info(`loaded ${offeringsByName.size} offering(s):`);
    for (const o of offeringsByName.values()) {
      log.info(
        `  - ${o.name}: ${o.priceValue} USDC (priceType=${o.priceType}, sla=${o.slaMinutes}min)`
      );
    }
  } catch (err) {
    log.warn(
      `failed to load registry offerings; will use fallback budget: ${err}`
    );
  }

  seller.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (
      entry.kind === "message" &&
      entry.from.toLowerCase() !== sellerAddress &&
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

          // ▸ Reject point #2 — late capability check.
          //   You usually catch capability issues at the requirement stage
          //   (below). But if an external dependency you rely on has gone
          //   down between budget.set and job.funded, you can still reject
          //   here — funds are returned to the buyer.
          //
          //   if (!await canDeliver()) {
          //     await session.sendMessage("Upstream service unavailable: <details>");
          //     await session.reject("upstream down");
          //     return;
          //   }

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
          // The seller stays running to accept more jobs — no `seller.stop()`
          // here. The session is terminal; later entries on it will be ignored
          // by the `status === "open"` guard below.
          const role = counterpartyRole(session, entry.event.rejector);
          log.job(
            session.jobId,
            `rejected by ${role} ${shortAddr(entry.event.rejector)}: ${entry.event.reason}`
          );
          break;
        }

        case "job.expired":
          // Like rejection, this is terminal but not actionable from the
          // seller side. Log and keep listening for new jobs.
          log.job(session.jobId, "expired");
          break;
      }
    }

    // The buyer's first message carries the structured requirement.
    // Guard on `status === "open"` for idempotency: once we've set a budget the
    // status advances to "budget_set", so replayed/duplicate entries are ignored.
    if (
      entry.kind === "message" &&
      entry.contentType === "requirement" &&
      session.status === "open"
    ) {
      // ▸ Reject point #1 — capability check.
      //   This is the natural place to refuse a job: the requirement just
      //   arrived, we haven't committed to anything on-chain, and the buyer
      //   hasn't funded yet. Reject if:
      //     • the on-chain offering name (job description) is missing or
      //       not one we serve
      //     • the requirement payload doesn't parse
      //     • the request itself is out of scope for this seller
      //
      //   We send the full diagnostic over chat with `sendMessage` first, then
      //   call `reject` with a short tag — so the buyer's `job.rejected`
      //   handler gets a clean tag *and* the chat history has the detail.

      const rejectWithDetail = async (
        tag: string,
        detail: string
      ): Promise<void> => {
        log.job(session.jobId, `rejecting — ${detail} (tag: "${tag}")`);
        await session.sendMessage(detail);
        await session.reject(tag);
      };

      // The offering name is set on-chain in the job's `description` field
      // by `createJobFromOffering`. We trust the on-chain value for routing
      // rather than expecting the message envelope to repeat it.
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

      // Resolve the budget from the offering registered on the registry.
      // `priceValue` is treated as USDC here; if your offering's `priceType`
      // refers to a different asset, swap `AssetToken.usdc` accordingly.
      const offering = offeringsByName.get(offeringName);
      if (!offering) {
        await rejectWithDetail(
          "unsupported offering",
          `Offering "${offeringName}" is not supported by this seller`
        );
        return;
      }
      log.job(
        session.jobId,
        `matched offering "${offering.name}" (${offering.priceValue} USDC, sla=${offering.slaMinutes}min)`
      );

      // Add domain-specific capability checks here, e.g.:
      //   if (!canHandle(requirementData)) {
      //     await session.reject("Request is out of capability");
      //     return;
      //   }

      try {
        await session.setBudget(
          AssetToken.usdc(offering.priceValue, session.chainId)
        );
        log.job(session.jobId, `set budget to ${offering.priceValue} USDC`);
      } catch (err) {
        log.error(`setBudget failed on job ${session.jobId}`, err);
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
