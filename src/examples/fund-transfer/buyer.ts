import { AcpAgent } from "../../acpAgent.js";
import { ACP_CONTRACT_ADDRESSES } from "../../core/constants.js";
import { base } from "@account-kit/infra";
import {
  type JobSession,
  type JobRoomEntry,
  PrivyAlchemyEvmProviderAdapter,
} from "../../index.js";
import { Address } from "viem";

const SELLER_ADDRESS: Address = "0xSellerAddress";

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
    contractAddresses: ACP_CONTRACT_ADDRESSES,
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: "0xBuyerWalletAddress",
      walletId: "your-privy-wallet-id",
      chains: [base],
      signerPrivateKey: "your-privy-signer-private-key",
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
        case "budget.set":
          log.job(
            session.jobId,
            `proposed budget ${entry.event.amount} USDC`
          );
          log.send(session, "Looks good, funding now.");
          await session.sendMessage("Looks good, funding now.");
          await session.fetchJob();
          await session.fund();
          log.job(session.jobId, "funded");
          break;

        case "job.submitted":
          log.job(session.jobId, "deliverable received, completing");
          await session.complete("Evaluated");
          log.job(session.jobId, "completed");
          await buyer.stop();
          break;
      }
    }
  });

  await buyer.start();
  log.info("ready");

  const jobId = await buyer.createFundTransferJob(base.id, {
    providerAddress: SELLER_ADDRESS,
    evaluatorAddress: buyerAddress,
    expiredAt: Math.floor(Date.now() / 1000) + 3600,
    description: "Example job from SDK",
  });

  log.job(jobId.toString(), "created — waiting for seller");
}

main().catch(console.error);
