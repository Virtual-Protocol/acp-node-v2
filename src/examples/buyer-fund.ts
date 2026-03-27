import { AcpAgent } from "../acpAgent";
import { AssetToken } from "../core/assetToken";
import { ACP_CONTRACT_ADDRESSES } from "../core/constants";
import { baseSepolia, bscTestnet } from "@account-kit/infra";
import {
  type JobSession,
  type JobRoomEntry,
  SocketTransport,
  PrivyAlchemyEvmProviderAdapter,
} from "../index";
import { Address } from "viem";

const SELLER_ADDRESS: Address = "0xSellerAddress";

async function main(): Promise<void> {
  const buyer = await AcpAgent.create({
    contractAddresses: ACP_CONTRACT_ADDRESSES,
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: "0xBuyerWalletAddress",
      walletId: "your-privy-wallet-id",
      chains: [baseSepolia, bscTestnet],
      signerPrivateKey: "your-privy-signer-private-key",
    }),
    transport: new SocketTransport(),
  });

  const buyerAddress = await buyer.getAddress();
  console.log(`[buyer] address: ${buyerAddress}`);

  buyer.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    console.log("entry", entry.kind);

    const job = await session.fetchJob();

    if (entry.kind === "system") {
      switch (entry.event.type) {
        case "budget.set":
          console.log(`[buyer] budget set on job ${session.jobId}, funding…`);
          await session.sendMessage("Looks good, funding now.");
          await session.fundWithTransfer(
            job.budget,
            AssetToken.usdc(0.022, session.chainId),
            SELLER_ADDRESS
          );
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

  const jobId = await buyer.createFundTransferJob(baseSepolia.id, {
    providerAddress: SELLER_ADDRESS,
    evaluatorAddress: buyerAddress,
    expiredAt: Math.floor(Date.now() / 1000) + 3600,
    description: "Example job from SDK",
  });

  console.log(`[buyer] created job ${jobId} — waiting for seller…`);
}

main().catch(console.error);
