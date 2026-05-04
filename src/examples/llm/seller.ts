import Anthropic from "@anthropic-ai/sdk";
import { base } from "@account-kit/infra";
import dotenv from "dotenv";
import { AcpAgent } from "../../acpAgent.js";
import { PrivyAlchemyEvmProviderAdapter } from "../../index.js";
import type { AcpTool, AcpAgentOffering } from "../../events/types.js";
import type { JobSession, JobRoomEntry } from "../../index.js";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// LLM-driven seller:
//
//   The agent's `entry` handler feeds every event through Claude, which picks
//   a tool to call. The SDK gates `availableTools()` by role + status, so the
//   LLM only ever sees actions it's allowed to take.
//
//   At startup the seller loads its own registered offerings and bakes them
//   into the system prompt as a price catalog. Per-session, it also prepends
//   a "current offering" note derived from `session.job.description` (the
//   on-chain offering name set by `createJobFromOffering`) so the LLM can
//   match the job to a registered offering and quote that exact price via
//   `setBudget`. This means the seller never hardcodes a price — it serves
//   whatever it has registered.
//
//   Terminal events (job.completed / job.rejected / job.expired) are handled
//   directly *before* the LLM call — a terminal session has no available
//   tools and Claude errors when called with `tool_choice: "any"` on an empty
//   tools list. The seller stays running across these (long-running daemon).
//
// Required env vars (see .env.example):
//   SELLER_WALLET_ADDRESS, SELLER_WALLET_ID, SELLER_SIGNER_PRIVATE_KEY,
//   ANTHROPIC_API_KEY
// ---------------------------------------------------------------------------

const chain = base;

const BASE_SYSTEM_PROMPT = `You are a meme seller agent.

Pricing:
- A "Current offering" system note tells you the listed price and the
  minimum acceptable price (the listed price minus a 20% discount floor).
- Initial setBudget = listed price.
- If the buyer counter-offers in chat (e.g. "Can you do 0.008 USDC?"),
  call setBudget again with:
    • the buyer's ask, if it is >= the minimum (you accept the discount), OR
    • the minimum, if their ask is below it (your firm floor — do not go lower).
- Never quote outside the [minimum, listed] band.
- If no offering matches the job, reject with a short reason.

Delivery:
- When funded, submit deliverable "http://meme.example".
- Keep all text under 10 words.`;

const anthropic = new Anthropic();

const shortAddr = (a: string): string =>
  !a || !a.startsWith("0x") || a.length < 12
    ? a
    : `${a.slice(0, 6)}…${a.slice(-4)}`;

const counterpartyRole = (session: JobSession, addr: string): string => {
  const job = session.job;
  if (!job) return "peer";
  const a = addr.toLowerCase();
  if (job.clientAddress.toLowerCase() === a) return "client";
  if (job.providerAddress.toLowerCase() === a) return "provider";
  if (job.evaluatorAddress.toLowerCase() === a) return "evaluator";
  return "peer";
};

const log = {
  info: (m: string) => console.log(`[seller-llm] ${m}`),
  job: (id: string | number, m: string) =>
    console.log(`[seller-llm] [job ${id}] ${m}`),
  chat: (session: JobSession, from: string, content: string) =>
    console.log(
      `[seller-llm] [job ${session.jobId}] ${counterpartyRole(
        session,
        from
      )} ${shortAddr(from)}: ${content}`
    ),
  warn: (m: string) => console.warn(`[seller-llm] [warn] ${m}`),
  error: (m: string, e?: unknown) =>
    console.error(`[seller-llm] [error] ${m}`, e ?? ""),
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

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

function buildOfferingCatalog(
  offerings: ReadonlyMap<string, AcpAgentOffering>
): string {
  if (offerings.size === 0) return "(no offerings registered)";
  return Array.from(offerings.values())
    .map(
      (o) =>
        `- "${o.name}": ${o.priceValue} USDC, sla=${o.slaMinutes}min — ${o.description}`
    )
    .join("\n");
}

function offeringContextNote(
  offeringName: string | undefined,
  matched: AcpAgentOffering | undefined
): string {
  if (!offeringName) {
    return `Current offering: (job description is empty — no offering selected; reject this job).`;
  }
  if (!matched) {
    return `Current offering: "${offeringName}" — NOT in your registered catalog. Reject this job.`;
  }
  const floor = matched.priceValue * 0.8;
  return (
    `Current offering: "${matched.name}" — ` +
    `listed ${matched.priceValue} USDC, ` +
    `minimum acceptable ${floor.toFixed(4)} USDC (20% discount floor), ` +
    `sla=${matched.slaMinutes}min.`
  );
}

async function main(): Promise<void> {
  const seller = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: requireEnv("SELLER_WALLET_ADDRESS") as `0x${string}`,
      walletId: requireEnv("SELLER_WALLET_ID"),
      signerPrivateKey: requireEnv("SELLER_SIGNER_PRIVATE_KEY"),
      chains: [chain],
    }),
  });

  const sellerAddress = (await seller.getAddress()).toLowerCase();
  log.info(`address: ${sellerAddress}`);

  // Load our own registry record once at startup and index offerings by name.
  // Tradeoff: this snapshots prices at process start. If you frequently update
  // offering prices and want them picked up without a restart, move this
  // lookup inline (call `getAgentByWalletAddress` per requirement message).
  const offeringsByName = new Map<string, AcpAgentOffering>();
  try {
    const me = await seller.getAgentByWalletAddress(sellerAddress);
    for (const o of me?.offerings ?? []) offeringsByName.set(o.name, o);
    log.info(`loaded ${offeringsByName.size} offering(s):`);
    for (const o of offeringsByName.values()) {
      log.info(
        `  - ${o.name}: ${o.priceValue} USDC (priceType=${o.priceType}, sla=${o.slaMinutes}min)`
      );
    }
  } catch (err) {
    log.warn(`failed to load registry offerings: ${err}`);
  }

  const systemPrompt =
    `${BASE_SYSTEM_PROMPT}\n\nYour registered offerings:\n${buildOfferingCatalog(offeringsByName)}`;

  seller.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind === "message") {
      log.chat(session, entry.from, entry.content);
    } else {
      // Terminal events get handled directly; the LLM has no tools available
      // for a session in a terminal status, so we never want to dispatch.
      //
      // `job.created` is also handled directly. The buyer's requirement
      // message arrives immediately after job.created, and both events
      // would otherwise dispatch the LLM with identical context (the first
      // setBudget hasn't yet materialized as a budget.set event when the
      // second dispatch fires, so status is still "open" and `setBudget`
      // is still in availableTools()) — producing duplicate setBudget
      // calls. Skip the dispatch on job.created and let the requirement
      // message be the single trigger; the LLM still sees the job.created
      // entry in `toMessages()` history when it eventually runs.
      switch (entry.event.type) {
        case "job.created":
          log.job(
            session.jobId,
            `new job from buyer ${shortAddr(entry.event.client)}; ` +
              `waiting for requirement before quoting`
          );
          return;
        case "job.completed":
          log.job(session.jobId, "completed");
          log.info("---- transcript ----");
          console.log(await session.toContext());
          log.info("---- end transcript ----");
          return;
        case "job.rejected": {
          const role = counterpartyRole(session, entry.event.rejector);
          log.job(
            session.jobId,
            `rejected by ${role} ${shortAddr(entry.event.rejector)}: ${entry.event.reason}`
          );
          return;
        }
        case "job.expired":
          log.job(session.jobId, "expired");
          return;
        default:
          log.job(session.jobId, `system event: ${entry.event.type}`);
      }
    }

    const tools = toAnthropicTools(session.availableTools());

    // Map this job's on-chain description (set by `createJobFromOffering`)
    // back to one of our registered offerings, and surface the match as a
    // system message so the LLM uses the right price for setBudget. We
    // prepend it to `toMessages()` rather than baking into the global
    // system prompt because the match is per-session.
    const offeringName = session.job?.description ?? undefined;
    const matched = offeringName ? offeringsByName.get(offeringName) : undefined;
    const rawMessages = await session.toMessages();
    rawMessages.unshift({
      role: "system",
      content: offeringContextNote(offeringName, matched),
    });
    const messages = toAnthropicMessages(rawMessages);

    log.job(session.jobId, `messages (${messages.length}):`);
    for (const m of messages) {
      console.log(`  ${m.role}: ${m.content}`);
    }

    if (messages.length === 0) return;

    const response = await anthropic.messages.create({
      model: "gemini-3.1-flash-lite-preview",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools,
      tool_choice: { type: "any" },
    });

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (toolBlock && toolBlock.type === "tool_use") {
      log.job(
        session.jobId,
        `calling ${toolBlock.name}(${JSON.stringify(toolBlock.input)})`
      );
      await session.executeTool(
        toolBlock.name,
        toolBlock.input as Record<string, unknown>
      );
    }
  });

  await seller.start();
  log.info("ready, listening for jobs");

  const shutdown = async (signal: NodeJS.Signals) => {
    log.info(`received ${signal}, shutting down`);
    await seller.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(console.error);
