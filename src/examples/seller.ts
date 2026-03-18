import { AcpAgent } from "../acpAgent";
import { Erc20Token } from "../core/erc20Token";
import { ACP_CONTRACT_ADDRESS } from "../core/constants";
import { baseSepolia } from "@account-kit/infra";
import { AlchemyEvmProviderAdapter } from "../providers/evm/alchemyEvmProviderAdapter";
import type { JobSession, JobRoomEntry } from "../index";

const SOCKET_SERVER_URL =
  process.env.SOCKET_SERVER_URL ?? "http://localhost:3000";

async function main(): Promise<void> {
  const seller = await AcpAgent.create({
    contractAddress: ACP_CONTRACT_ADDRESS,
    provider: await AlchemyEvmProviderAdapter.create({
      walletAddress: "0xSellerWalletAddress",
      privateKey:
        "0xSellerPrivateKey",
      entityId: 1,
      chain: baseSepolia,
    }),
    transport: { type: "socket", url: SOCKET_SERVER_URL },
  });

  console.log(`[seller] address: ${await seller.getAddress()}`);
  console.log("[seller] listening for jobs…");

  seller.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    const job = await session.fetchJob();

    if (entry.kind === "system") {
      switch (entry.event.type) {
        case "job.created":
          console.log(
            `[seller] new job ${session.jobId}: "${job?.description}"`
          );
          await session.sendMessage("I can handle this. Proposing 0.1 USDC.");
          await session.setBudget(Erc20Token.usdc(0.1));
          console.log(`[seller] set budget on job ${session.jobId}`);
          break;

        case "job.funded":
          console.log(`[seller] job ${session.jobId} funded, delivering…`);
          await session.sendMessage("Got the funds. Working on it now.");
          await session.submit("Test deliverable");
          console.log(`[seller] submitted deliverable on job ${session.jobId}`);
          break;

        case "job.completed":
          console.log(`[seller] job ${session.jobId} completed!`);
          console.log(session.toContext());
          break;
      }
    }

    if (entry.kind === "message") {
      console.log(
        `[seller] [job ${session.jobId}] ${entry.from}: ${entry.content}`
      );
    }
  });

  await seller.start();
}

main().catch(console.error);
