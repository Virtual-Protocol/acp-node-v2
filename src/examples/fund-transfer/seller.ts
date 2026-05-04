import { AcpAgent } from "../../acpAgent.js";
import { AssetToken } from "../../core/assetToken.js";
import { base } from "@account-kit/infra";
import { PrivyAlchemyEvmProviderAdapter } from "../../providers/evm/privyAlchemyEvmProviderAdapter.js";
import { type JobSession, type JobRoomEntry } from "../../index.js";

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

async function main(): Promise<void> {
  const seller = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: "0xSellerWalletAddress",
      walletId: "seller-wallet-id",
      signerPrivateKey: "0xSellerSignerPrivateKey",
      chains: [base],
    }),
  });

  const sellerAddress = (await seller.getAddress()) as `0x${string}`;
  log.info(`address: ${sellerAddress}`);

  seller.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (
      entry.kind === "message" &&
      entry.from.toLowerCase() !== sellerAddress.toLowerCase() &&
      entry.contentType !== "requirement"
    ) {
      log.chat(session, entry.from, entry.content);
    }

    if (entry.kind === "system") {
      switch (entry.event.type) {
        case "job.created":
          log.job(session.jobId, "new job received");
          break;

        case "job.funded":
          log.job(session.jobId, "funded, delivering");
          log.send(session, "Got the funds. Working on it now.");
          await session.sendMessage("Got the funds. Working on it now.");
          await session.submit("Test deliverable");
          log.job(session.jobId, "submitted deliverable");
          break;

        case "job.completed":
          log.job(session.jobId, "completed");
          break;
      }
    }

    // Handle the buyer's first message containing the requirement
    if (
      entry.kind === "message" &&
      entry.contentType === "requirement" &&
      session.status === "open"
    ) {
      const requirementData = JSON.parse(entry.content);
      const offeringName = session.job?.description ?? "(unknown)";
      log.job(
        session.jobId,
        `received requirement for "${offeringName}": ${JSON.stringify(
          requirementData
        )}`
      );
      await session.setBudgetWithFundRequest(
        AssetToken.usdc(0.1, session.chainId),
        AssetToken.usdc(0.022, session.chainId),
        sellerAddress
      );
      log.job(session.jobId, "set budget with fund request (0.1 / 0.022 USDC)");
    }
  });

  await seller.start();
  log.info("ready, listening for jobs");
}

main().catch(console.error);
