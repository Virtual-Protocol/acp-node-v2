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
    subsection("Skeleton");
    console.log("(no demos yet — see Task 3+ in the implementation plan)");
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
