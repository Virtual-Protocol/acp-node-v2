import { AcpAgent } from "../acpAgent";
import { AssetToken } from "../core/assetToken";
import { baseSepolia } from "@account-kit/infra";
import { AlchemyEvmProviderAdapter } from "../providers/evm/alchemyEvmProviderAdapter";
import { SocketTransport } from "../events/socketTransport";
import type { JobSession, JobRoomEntry } from "../index";

async function main(): Promise<void> {
  const seller = await AcpAgent.create({
    provider: await AlchemyEvmProviderAdapter.create({
      walletAddress: "0xSellerWalletAddress",
      privateKey: "0xSellerPrivateKey",
      entityId: 1,
      chains: [baseSepolia],
    }),
    transport: new SocketTransport(),
  });

  console.log(`[seller] address: ${await seller.getAddress()}`);

  seller.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind === "system") {
      switch (entry.event.type) {
        case "job.created":
          console.log(`[seller] new job ${session.jobId}`);
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

    // Handle the buyer's first message containing the requirement
    if (
      entry.kind === "message" &&
      entry.contentType === "requirement" &&
      session.status === "open"
    ) {
      const requirement = JSON.parse(entry.content);
      console.log(
        `[seller] received requirement for "${requirement.name}":`,
        requirement.requirement
      );
      await session.setBudget(AssetToken.usdc(0.1, session.chainId));
      console.log(`[seller] set budget on job ${session.jobId}`);
    }
  });

  await seller.start(() => {
    console.log("[seller callback] listening for jobs…");
  });
}

main().catch(console.error);
