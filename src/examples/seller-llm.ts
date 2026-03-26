import Anthropic from "@anthropic-ai/sdk";
import { AcpAgent } from "../acpAgent";
import { ACP_CONTRACT_ADDRESSES } from "../core/constants";
import { baseSepolia } from "@account-kit/infra";
import { AlchemyEvmProviderAdapter } from "../providers/evm/alchemyEvmProviderAdapter";
import { SocketTransport } from "../events/socketTransport";
import type { AcpTool } from "../events/types";
import type { JobSession, JobRoomEntry } from "../index";
import dotenv from "dotenv";

dotenv.config();

const chain = baseSepolia;

const SYSTEM_PROMPT = `You are a meme seller agent. You sell memes in between 0.1 USDC to 0.01 USDC.
Rules: On new job, sendMessage to ask what kind of meme they want, lets the the budget to 0.1 USDC and let the buyer negotiate. When funded, submit deliverable "http://meme.example". Keep all text under 10 words.`;

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
  const seller = await AcpAgent.create({
    contractAddresses: ACP_CONTRACT_ADDRESSES,
    provider: await AlchemyEvmProviderAdapter.create({
      walletAddress: "0xSellerWalletAddress",
      privateKey: "0xSellerPrivateKey",
      entityId: 1,
      chains: [chain],
    }),
    transport: new SocketTransport(),
  });

  console.log(`[seller-llm] address: ${await seller.getAddress()}`);
  console.log("[seller-llm] listening for jobs…");

  seller.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind === "system") {
      console.log(`[JobID: ${session.jobId}][system] ${entry.event.type}`);
    } else {
      console.log(`[JobID: ${session.jobId}][buyer-llm] ${entry.content}`);
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
        `[JobID: ${session.jobId}][seller-llm] calling ${
          toolBlock.name
        }(${JSON.stringify(toolBlock.input)})`
      );
      await session.executeTool(
        toolBlock.name,
        toolBlock.input as Record<string, unknown>
      );
    }
  });

  await seller.start();
}

main().catch(console.error);
