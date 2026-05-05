import { base } from "@account-kit/infra";
import dotenv from "dotenv";
import {
  AcpAgent,
  AssetToken,
  PrivyAlchemyEvmProviderAdapter,
  type AcpAgentOffering,
  type AcpAgentSubscription,
  type JobRoomEntry,
  type JobSession,
} from "../../index.js";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// Subscription + fund-transfer seller lifecycle:
//
//   Same on-chain flow as subscription/seller.ts (job.created → requirement
//   message → setBudget → job.funded → submit → job.completed), but the
//   offering is configured with both SubscriptionHook AND FundTransferHook —
//   so `setBudget` becomes `setBudgetWithSubscriptionAndFundRequest` whenever
//   the buyer's requirement message carries a `packageId`. Three cases:
//
//     • Buyer sent a `packageId` and the subscription is **not yet active**:
//         budget        = offering.priceValue + subscription.price
//         transferAmount = configured fund-transfer amount → destination
//         (the first job pays the offering, activates the package, and
//         forwards the configured amount to the destination)
//
//     • Buyer sent a `packageId` and the subscription IS active:
//         budget        = 0
//         transferAmount = configured fund-transfer amount → destination
//         (subsequent jobs are covered by the still-active package; the
//         fund transfer still happens because that hook fires per-job)
//
//     • Buyer omitted `packageId`: fall back to `setBudgetWithFundRequest`
//         (offering price only, no subscription, fund transfer still fires).
//
// Required env vars (see .env.example):
//   SELLER_WALLET_ADDRESS, SELLER_WALLET_ID, SELLER_SIGNER_PRIVATE_KEY
// Optional env vars:
//   FUND_TRANSFER_DESTINATION — defaults to the seller address
// ---------------------------------------------------------------------------

const FUND_TRANSFER_AMOUNT = 0.022;

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
  info: (m: string) => console.log(`[seller-sub-fund] ${m}`),
  job: (id: string | number, m: string) =>
    console.log(`[seller-sub-fund] [job ${id}] ${m}`),
  chat: (session: JobSession, from: string, content: string) =>
    console.log(
      `[seller-sub-fund] [job ${session.jobId}] ${counterpartyRole(
        session,
        from
      )} ${shortAddr(from)}: ${content}`
    ),
  send: (session: JobSession, content: string) =>
    console.log(`[seller-sub-fund] [job ${session.jobId}] me: ${content}`),
  warn: (m: string) => console.warn(`[seller-sub-fund] [warn] ${m}`),
  error: (m: string, e?: unknown) =>
    console.error(`[seller-sub-fund] [error] ${m}`, e ?? ""),
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

  // Where the FundTransferHook should forward the per-job transfer amount.
  // Defaults to the seller's own address (so the seller receives both the
  // offering payment via the budget AND the fund-transfer amount). Override
  // with FUND_TRANSFER_DESTINATION when forwarding to a third party.
  const fundTransferDestination = (process.env.FUND_TRANSFER_DESTINATION ??
    sellerAddress) as `0x${string}`;
  log.info(
    `fund-transfer destination: ${fundTransferDestination} (${FUND_TRANSFER_AMOUNT} USDC per job)`
  );

  // Snapshot offerings + subscriptions from the registry at startup. The
  // buyer's requirement message carries `session.job.description` (the
  // offering name) and optionally `entry.packageId` — we resolve both
  // against this snapshot to compute the budget.
  //
  // Tradeoff: this is a one-time read. If you frequently update prices or
  // packages on the registry, move the lookup inline (re-fetch on each
  // requirement) so the seller picks them up without a restart.
  let offeringsByName = new Map<string, AcpAgentOffering>();
  let subscriptionsByPackageId = new Map<number, AcpAgentSubscription>();
  try {
    const me = await seller.getMe();
    offeringsByName = new Map(me.offerings.map((o) => [o.name, o] as const));
    subscriptionsByPackageId = new Map(
      me.subscriptions.map((s) => [s.packageId, s] as const)
    );
    log.info(`loaded ${offeringsByName.size} offering(s):`);
    for (const o of offeringsByName.values()) {
      log.info(
        `  - ${o.name}: ${o.priceValue} USDC (priceType=${o.priceType}, sla=${o.slaMinutes}min)`
      );
    }
    log.info(`loaded ${subscriptionsByPackageId.size} subscription(s):`);
    for (const s of subscriptionsByPackageId.values()) {
      log.info(
        `  - "${s.name}" packageId=${s.packageId} (${s.price} USDC / ${s.duration}s)`
      );
    }
  } catch (err) {
    log.warn(`failed to load registry data: ${err}`);
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

          // ▸ Reject point #2 — late capability check. Funds are returned
          //   to the buyer if you reject here.
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
          const role = counterpartyRole(session, entry.event.rejector);
          log.job(
            session.jobId,
            `rejected by ${role} ${shortAddr(entry.event.rejector)}: ${
              entry.event.reason
            }`
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
      // ▸ Reject point #1 — capability check. Send a chat message with the
      //   diagnostic, then reject with a short tag so the buyer's
      //   `job.rejected` handler gets a clean tag *and* the chat history
      //   has the detail.
      const rejectWithDetail = async (
        tag: string,
        detail: string
      ): Promise<void> => {
        log.job(session.jobId, `rejecting — ${detail} (tag: "${tag}")`);
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

      const transferAmount = AssetToken.usdc(
        FUND_TRANSFER_AMOUNT,
        session.chainId
      );

      // Subscription + fund-transfer branch: the buyer flagged a package on
      // the requirement message AND the offering is configured with the
      // FundTransferHook. The first job activates the package (offering
      // price + subscription fee) and forwards `transferAmount` to the
      // destination; while the package is still active the budget drops to
      // 0 but the fund transfer still fires per-job.
      if (entry.packageId !== undefined) {
        const subscription = subscriptionsByPackageId.get(entry.packageId);
        if (!subscription) {
          await rejectWithDetail(
            "unknown package",
            `Subscription package ${entry.packageId} is not registered for this seller`
          );
          return;
        }

        // We need the on-chain client/provider addresses to query the
        // subscription state contract. `fetchJob()` populates `session.job`
        // (and returns it) so we can pass them through.
        const job = await session.fetchJob();
        const isActive = await seller.isSubscriptionActive(
          session.chainId,
          job.clientAddress,
          job.providerAddress,
          subscription.packageId
        );

        const totalPrice = isActive
          ? 0
          : offering.priceValue + subscription.price;

        try {
          await session.setBudgetWithSubscriptionAndFundRequest(
            AssetToken.usdc(totalPrice, session.chainId),
            BigInt(subscription.duration),
            BigInt(subscription.packageId),
            transferAmount,
            fundTransferDestination
          );
          log.job(
            session.jobId,
            isActive
              ? `set budget to 0 USDC + ${FUND_TRANSFER_AMOUNT} USDC fund-transfer to ${shortAddr(
                  fundTransferDestination
                )} (subscription ${subscription.name} already active — covered)`
              : `set budget to ${totalPrice} USDC + ${FUND_TRANSFER_AMOUNT} USDC fund-transfer to ${shortAddr(
                  fundTransferDestination
                )} (offering ${offering.priceValue} + subscription ${
                  subscription.name
                } ${subscription.price} — activates package)`
          );
        } catch (err) {
          log.error(
            `setBudgetWithSubscriptionAndFundRequest failed on job ${session.jobId}`,
            err
          );
        }
        return;
      }

      // No subscription package on this requirement — fall back to a
      // fund-transfer-only budget. This path is only reachable if the buyer
      // used a non-subscription path on a hybrid offering (i.e. the offering
      // exposes both a SubscriptionHook and a plain FundTransferHook entry).
      try {
        await session.setBudgetWithFundRequest(
          AssetToken.usdc(offering.priceValue, session.chainId),
          transferAmount,
          fundTransferDestination
        );
        log.job(
          session.jobId,
          `set budget to ${
            offering.priceValue
          } USDC + ${FUND_TRANSFER_AMOUNT} USDC fund-transfer to ${shortAddr(
            fundTransferDestination
          )}`
        );
      } catch (err) {
        log.error(
          `setBudgetWithFundRequest failed on job ${session.jobId}`,
          err
        );
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
