import { AcpAgent } from "../acpAgent";
import { AssetToken } from "../core/assetToken";
import { ACP_CONTRACT_ADDRESSES } from "../core/constants";
import { baseSepolia } from "@account-kit/infra";
import { AlchemyEvmProviderAdapter } from "../providers/evm/alchemyEvmProviderAdapter";
import { SocketTransport } from "../events/socketTransport";
import type { JobSession, JobRoomEntry } from "../index";

const SELLER_ADDRESS = "0xSellerAddress";
const chain = baseSepolia;

async function main(): Promise<void> {
  const buyer = await AcpAgent.create({
    contractAddresses: ACP_CONTRACT_ADDRESSES,
    provider: await AlchemyEvmProviderAdapter.create({
      walletAddress: "0xBuyerWalletAddress",
      privateKey: "0xBuyerPrivateKey",
      entityId: 1,
      chains: [chain],
    }),
    transport: new SocketTransport(),
  });

  const buyerAddress = await buyer.getAddress();
  console.log(`[buyer] address: ${buyerAddress}`);

  buyer.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind === "system") {
      switch (entry.event.type) {
        case "budget.set":
          console.log(`[buyer] budget set on job ${session.jobId}, funding…`);
          await session.sendMessage("Looks good, funding now.");
          await session.fund(AssetToken.usdc(0.1, session.chainId));
          console.log(`[buyer] funded job ${session.jobId}`);
          break;

        case "job.submitted":
          console.log(
            `[buyer] deliverable received on job ${session.jobId}, completing…`
          );
          await session.complete("Evaluated");
          console.log(`[buyer] completed job ${session.jobId}`);
          await buyer.stop();
          break;
      }
    }

    if (entry.kind === "message") {
      console.log(
        `[buyer] [job ${session.jobId}] ${entry.from}: ${entry.content}`
      );
    }
  });

  await buyer.start();

  const jobId = await buyer.createJob(chain.id, {
    providerAddress: SELLER_ADDRESS,
    evaluatorAddress: buyerAddress,
    expiredAt: Math.floor(Date.now() / 1000) + 3600,
    description: "Example job from SDK",
  });

  console.log(`[buyer] created job ${jobId} — waiting for seller…`);
}

main().catch(console.error);
