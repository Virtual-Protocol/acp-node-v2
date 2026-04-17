import { AcpAgent } from "../acpAgent";
import { AssetToken } from "../core/assetToken";
import { baseSepolia } from "@account-kit/infra";
import { PrivyAlchemyEvmProviderAdapter } from "../providers/evm/privyAlchemyEvmProviderAdapter";
import { SocketTransport } from "../events/socketTransport";
import { type JobSession, type JobRoomEntry, AgentSort } from "../index";

const chain = baseSepolia;

async function main(): Promise<void> {
  const buyer = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: "0xBuyerWalletAddress",
      walletId: "buyer-wallet-id",
      signerPrivateKey: "0xBuyerSignerPrivateKey",
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

  // 1. Browse for agents
  const agents = await buyer.browseAgents("<search query>", {
    sortBy: [AgentSort.SUCCESSFUL_JOB_COUNT, AgentSort.SUCCESS_RATE],
    topK: 5,
    showHidden: true,
  });

  const agent = agents[0];
  if (!agent) {
    console.error("No agents found matching the search query");
    return;
  }

  // 2. Select an offering
  const offering = agent.offerings[0];
  if (!offering) {
    console.error("Agent has no offerings");
    return;
  }

  // 3. Create job from offering (validates requirement, creates job, sends first message)
  // expiredAt is auto-calculated from offering.slaMinutes
  const jobId = await buyer.createJobFromOffering(
    chain.id,
    offering,
    agent.walletAddress,
    { "<your-schema-key>": "<your-schema-value>" }, // requirement data matching offering schema
    { evaluatorAddress: buyerAddress }
  );

  console.log(`[buyer] created job ${jobId} — waiting for seller…`);
}

main().catch(console.error);
