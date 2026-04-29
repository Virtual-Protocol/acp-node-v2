import { AcpAgent } from "../acpAgent";
import { AssetToken } from "../core/assetToken";
import { baseSepolia } from "@account-kit/infra";
import { PrivyAlchemyEvmProviderAdapter } from "../providers/evm/privyAlchemyEvmProviderAdapter";
import { type JobSession, type JobRoomEntry, SocketTransport } from "../index";

async function main(): Promise<void> {
  const seller = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: "0xSellerWalletAddress",
      walletId: "seller-wallet-id",
      signerPrivateKey: "0xSellerSignerPrivateKey",
      chains: [baseSepolia],
    }),
    transport: new SocketTransport(),
  });

  const sellerAddress = (await seller.getAddress()) as `0x${string}`;
  console.log(`[seller] address: ${sellerAddress}`);

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

      if (entry.packageId) {
        const job = await session.fetchJob();
        const agent = await seller.getMe();
        const subscription = agent.subscriptions.find(
          (subscription) => subscription.packageId === entry.packageId
        );

        if (!subscription) {
          throw new Error(
            `Subscription with packageId ${entry.packageId} not found`
          );
        }

        const isActiveSubscription = await seller.isSubscriptionActive(
          session.chainId,
          job.clientAddress,
          job.providerAddress,
          subscription.packageId
        );

        const offeringPrice = 0.1;
        const totalPrice =
          offeringPrice + (isActiveSubscription ? 0 : subscription.price);

        await session.setBudget(AssetToken.usdc(totalPrice, session.chainId), {
          duration: BigInt(subscription.duration),
          packageId: BigInt(subscription.packageId),
        });
      } else {
        await session.setBudget(AssetToken.usdc(0.1, session.chainId));
      }

      console.log(`[seller] set budget on job ${session.jobId}`);
    }
  });

  await seller.start(() => {
    console.log("[seller callback] listening for jobs…");
  });
}

main().catch(console.error);
