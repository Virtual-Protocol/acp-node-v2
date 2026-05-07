import { base } from "@account-kit/infra";
import dotenv from "dotenv";
import {
  AcpAgent,
  PrivyAlchemyEvmProviderAdapter,
} from "../../index.js";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// ACP SDK Public Helper Functions — runnable showcase.
//
// This script exercises every public read/introspection API on AcpAgent,
// AcpJobApi, AcpChatTransport, and JobSession. It is intentionally a single
// linear script with delimited subsections (see `subsection()`) so a dev
// can read it top-to-bottom and see exactly which method produces which
// shape of output.
//
// Env vars (from the repo root .env, same keys as basic/buyer.ts):
//   BUYER_WALLET_ADDRESS, BUYER_WALLET_ID, BUYER_SIGNER_PRIVATE_KEY
// Optional:
//   SELLER_WALLET_ADDRESS — exercised by the getAgentByWalletAddress demo
// ---------------------------------------------------------------------------

const chain = base;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function subsection(title: string): void {
  console.log(`\n--- ${title} ---`);
}

function header(title: string): void {
  const bar = "=".repeat(60);
  console.log(`\n${bar}\n${title}\n${bar}`);
}

async function main(): Promise<void> {
  header("ACP SDK Public Helper Functions");

  console.log("\nInitializing ACP agent...");
  const agent = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: requireEnv("BUYER_WALLET_ADDRESS") as `0x${string}`,
      walletId: requireEnv("BUYER_WALLET_ID"),
      signerPrivateKey: requireEnv("BUYER_SIGNER_PRIVATE_KEY"),
      chains: [chain],
    }),
  });

  try {
    // Subsections added in subsequent tasks plug in here.
    /* ---------------- AGENT IDENTITY ---------------- */
    subsection("Agent identity");
    const address = await agent.getAddress();
    console.log(`address:           ${address}`);
    console.log(`supported chains:  ${JSON.stringify(agent.getSupportedChainIds())}`);

    /* ---------------- SELF REGISTRY PROFILE ---------------- */
    subsection("Self registry profile (getMe)");
    try {
      const me = await agent.getMe();
      console.log(`name:              ${me.name}`);
      console.log(`role:              ${me.role}`);
      console.log(`offerings:         ${me.offerings.length}`);
      for (const o of me.offerings) {
        console.log(
          `  - "${o.name}" — ${o.priceValue} USDC, sla=${o.slaMinutes}min, ` +
            `requiredFunds=${o.requiredFunds}, hidden=${o.isHidden}`
        );
      }
      console.log(`subscriptions:     ${me.subscriptions.length}`);
      for (const s of me.subscriptions) {
        console.log(
          `  - "${s.name}" packageId=${s.packageId}, ${s.price} USDC, ${s.duration}s`
        );
      }
    } catch (err) {
      console.log(`getMe failed (is this wallet registered?): ${err}`);
    }

    /* ---------------- DIRECT LOOKUP ---------------- */
    subsection("Direct lookup (getAgentByWalletAddress)");
    const sellerAddress = process.env.SELLER_WALLET_ADDRESS;
    if (sellerAddress) {
      const seller = await agent.getAgentByWalletAddress(sellerAddress);
      if (seller) {
        console.log(
          `found "${seller.name}" at ${seller.walletAddress} — ` +
            `${seller.offerings.length} offering(s)`
        );
      } else {
        console.log(`no agent registered at ${sellerAddress}`);
      }
    } else {
      console.log("skipped — SELLER_WALLET_ADDRESS not set");
    }

    /* ---------------- REGISTRY BROWSE ---------------- */
    subsection("Registry browse (browseAgents)");
    const browsed = await agent.browseAgents("agent", {
      topK: 3,
      showHidden: true,
    });
    console.log(`top ${browsed.length} agent(s) matching "agent":`);
    for (const a of browsed) {
      console.log(
        `  - "${a.name}" ${a.walletAddress} — ${a.offerings.length} offering(s)`
      );
    }
  } finally {
    await agent.stop();
  }
}

main()
  .then(() => {
    console.log("\nDone.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nError running helper functions:", err);
    process.exit(1);
  });
