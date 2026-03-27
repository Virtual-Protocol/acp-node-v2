import { AcpAgent } from "../acpAgent";
import { AssetToken } from "../core/assetToken";
import { ACP_CONTRACT_ADDRESSES } from "../core/constants";
import { baseSepolia } from "@account-kit/infra";
import { AlchemyEvmProviderAdapter } from "../providers/evm/alchemyEvmProviderAdapter";
import { type JobSession, type JobRoomEntry } from "../index";
import type { Address } from "viem";

async function main(): Promise<void> {
  const seller = await AcpAgent.create({
    contractAddresses: ACP_CONTRACT_ADDRESSES,
    provider: await AlchemyEvmProviderAdapter.create({
      walletAddress: "0xSellerWalletAddress",
      privateKey: "0xSellerPrivateKey",
      entityId: 1,
      chains: [baseSepolia],
    }),
  });

  console.log(`[seller] address: ${await seller.getAddress()}`);

  seller.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    const job = await session.fetchJob();

    if (entry.kind === "system") {
      switch (entry.event.type) {
        case "job.created":
          console.log(
            `[seller] new job ${session.jobId}: "${job?.description}"`
          );
          await session.sendMessage("I can handle this. Proposing 0.1 USDC.");
          await session.setBudgetWithFundRequest(
            AssetToken.usdc(0.1, session.chainId),
            AssetToken.usdc(0.022, session.chainId),
            (await seller.getAddress()) as Address
          );
          console.log(`[seller] set budget on job ${session.jobId}`);
          break;

        case "job.funded":
          console.log(`[seller] job ${session.jobId} funded, delivering…`);
          await session.sendMessage("Got the funds. Working on it now.");
          await session.submitWithTransfer(
            "Test deliverable",
            AssetToken.usdc(0.033, session.chainId)
          );
          console.log(`[seller] submitted deliverable on job ${session.jobId}`);
          break;

        case "job.completed":
          console.log(`[seller] job ${session.jobId} completed!`);
          break;
      }
    }

    if (entry.kind === "message") {
      console.log(
        `[seller] [job ${session.jobId}] ${entry.from}: ${entry.content}`
      );
    }
  });

  await seller.start(() => {
    console.log("[seller callback] listening for jobs…");
  });
}

main().catch(console.error);
