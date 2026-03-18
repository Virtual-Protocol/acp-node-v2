import Anthropic from "@anthropic-ai/sdk";
import { AcpAgent } from "../acpAgent";
import { ACP_CONTRACT_ADDRESS } from "../core/constants";
import { baseSepolia } from "@account-kit/infra";
import { AlchemyEvmProviderAdapter } from "../providers/evm/alchemyEvmProviderAdapter";
import type { AcpTool } from "../events/types";
import type { JobSession, JobRoomEntry } from "../index";
import dotenv from "dotenv";
import { PrivyAlchemyEvmProviderAdapter } from "../providers/evm/privyAlchemyEvmProviderAdapter";

dotenv.config();

const SELLER_ADDRESS = "0xSellerAddress";
const SOCKET_SERVER_URL =
  process.env.SOCKET_SERVER_URL ?? "http://localhost:3000";

const SYSTEM_PROMPT = `You are a buyer agent. You want to buy a funny cat meme.
Rules: When the seller asks what you want, sendMessage describing your requirement (e.g. "I want a funny cat meme") and ask for a price. Fund any budget under 0.1 USDC. Try to negotation for price below 0.07 USDC. Complete any deliverable. Keep all text under 10 words.`;

const anthropic = new Anthropic();

function toAnthropicTools(tools: AcpTool[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: Object.fromEntries(
        t.parameters.map((p) => [
          p.name,
          { type: p.type, description: p.description },
        ])
      ),
      required: t.parameters
        .filter((p) => p.required !== false)
        .map((p) => p.name),
    },
  }));
}

function toAnthropicMessages(
  raw: { role: "system" | "user" | "assistant"; content: string }[]
): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = [];
  for (const m of raw) {
    const role = m.role === "system" ? "user" : m.role;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) {
      last.content += "\n" + m.content;
    } else {
      msgs.push({ role, content: m.content });
    }
  }
  return msgs;
}

async function main(): Promise<void> {
  const buyer = await AcpAgent.create({
    contractAddress: ACP_CONTRACT_ADDRESS,
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: "0xBuyerWalletAddress",
      walletId: "your-privy-wallet-id",
      signerPrivateKey: "your-privy-signer-private-key",
    }),
    transport: { type: "socket", url: SOCKET_SERVER_URL },
  });

  const buyerAddress = await buyer.getAddress();
  console.log(`[buyer-llm] address: ${buyerAddress}`);

  buyer.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind === "system") {
      console.log(`[JobID: ${session.jobId}][system] ${entry.event.type}`);
    } else {
      console.log(`[JobID: ${session.jobId}][seller-llm] ${entry.content}`);
    }

    const tools = toAnthropicTools(session.availableTools());
    const messages = toAnthropicMessages(session.toMessages());

    console.log("messages", messages);

    if (messages.length === 0) return;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
      tools,
      tool_choice: { type: "any" },
    });

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (toolBlock && toolBlock.type === "tool_use") {
      console.log(
        `[JobID: ${session.jobId}][buyer-llm] calling ${
          toolBlock.name
        }(${JSON.stringify(toolBlock.input)})`
      );
      await session.executeTool(
        toolBlock.name,
        toolBlock.input as Record<string, unknown>
      );
    }
  });

  await buyer.start();

  const jobId = await buyer.createJob({
    providerAddress: SELLER_ADDRESS,
    evaluatorAddress: buyerAddress,
    expiredAt: Math.floor(Date.now() / 1000) + 3600,
    description: "I want to buy a funny meme",
  });

  console.log(`[buyer-llm] created job ${jobId} — waiting for seller…`);
}

main().catch(console.error);
