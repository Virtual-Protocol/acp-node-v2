import Anthropic from "@anthropic-ai/sdk";
import { base } from "@account-kit/infra";
import dotenv from "dotenv";
import * as readline from "node:readline";
import { AcpAgent } from "../../acpAgent";
import { PrivyAlchemyEvmProviderAdapter } from "../../index";
import type { AcpTool, AcpAgentOffering } from "../../events/types";
import type { JobSession, JobRoomEntry } from "../../index";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// LLM-driven buyer:
//
//   The agent's `entry` handler feeds every event through Claude, which picks
//   a tool to call. The SDK gates `availableTools()` by role + status, so the
//   LLM only ever sees actions it's allowed to take.
//
//   Job kickoff is also LLM-driven: the buyer fetches the seller's registered
//   offerings, hands the catalog to Claude, and lets it choose one (by name)
//   plus build a requirement payload. The result is passed to
//   `createJobByOfferingName`, which validates the payload against the
//   offering's JSON schema and creates the on-chain job. This means the
//   buyer never hardcodes a price or an offering — it reasons over whatever
//   the seller has registered.
//
//   Terminal events (job.completed / job.rejected / job.expired) are handled
//   directly *before* the LLM call — partly for parity with basic/buyer.ts,
//   partly because a terminal session has no available tools and Claude
//   errors when called with `tool_choice: "any"` on an empty tools list.
//
// Required env vars (see .env.example):
//   BUYER_WALLET_ADDRESS, BUYER_WALLET_ID, BUYER_SIGNER_PRIVATE_KEY,
//   SELLER_WALLET_ADDRESS, ANTHROPIC_API_KEY
// ---------------------------------------------------------------------------

const chain = base;

const SYSTEM_PROMPT = `You are a buyer agent. You want to buy a funny cat meme.

Job kickoff:
- You'll be shown the seller's offerings catalog. Pick the offering whose
  name/description best fits a funny cat meme and call the createJob tool
  with its exact name and a requirement payload that satisfies the
  offering's requirements schema.

In session:
- When budget.set fires, a "Current offering" system note tells you the
  offering's listed price and a 20%-off discount target. If you haven't
  haggled yet on this job, sendMessage asking for the discount. If you've
  already counter-offered once, just fund whatever the seller proposes —
  you picked this offering, so its price is on-spec by construction.
- Never reject. The price is bounded by the offering you already chose.
- Complete any deliverable.
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
  info: (m: string) => console.log(`[buyer-llm] ${m}`),
  job: (id: string | number, m: string) =>
    console.log(`[buyer-llm] [job ${id}] ${m}`),
  chat: (session: JobSession, from: string, content: string) =>
    console.log(
      `[buyer-llm] [job ${session.jobId}] ${counterpartyRole(
        session,
        from
      )} ${shortAddr(from)}: ${content}`
    ),
  warn: (m: string) => console.warn(`[buyer-llm] [warn] ${m}`),
  error: (m: string, e?: unknown) =>
    console.error(`[buyer-llm] [error] ${m}`, e ?? ""),
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(defaultYes);
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "") return resolve(defaultYes);
      resolve(a === "y" || a === "yes");
    });
  });
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

async function main(): Promise<void> {
  const buyer = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: requireEnv("BUYER_WALLET_ADDRESS") as `0x${string}`,
      walletId: requireEnv("BUYER_WALLET_ID"),
      signerPrivateKey: requireEnv("BUYER_SIGNER_PRIVATE_KEY"),
      chains: [chain],
    }),
  });

  const buyerAddress = await buyer.getAddress();
  log.info(`address: ${buyerAddress}`);

  // Load the seller's offering catalog up front. We need it both for the
  // kickoff (the LLM picks an offering by name) and per-session (we surface
  // the listed price as a "Current offering" note so the LLM has a concrete
  // anchor to negotiate against — without this it'd be haggling blind).
  // Loading before `buyer.start()` ensures it's also available to any
  // sessions hydrated on restart, since hydration fires the entry handler
  // synchronously inside `start()`.
  const sellerAddress = requireEnv("SELLER_WALLET_ADDRESS");
  log.info(`looking up seller offerings at ${shortAddr(sellerAddress)}`);
  const sellerAgent = await buyer.getAgentByWalletAddress(sellerAddress);
  if (!sellerAgent) {
    log.error(`no agent registered at ${shortAddr(sellerAddress)}`);
    return;
  }
  if (sellerAgent.offerings.length === 0) {
    log.error(`agent ${shortAddr(sellerAddress)} has no offerings registered`);
    return;
  }
  const offeringsByName = new Map<string, AcpAgentOffering>();
  for (const o of sellerAgent.offerings) offeringsByName.set(o.name, o);
  log.info(
    `found ${offeringsByName.size} offering(s) from ${shortAddr(
      sellerAgent.walletAddress
    )}:`
  );
  for (const o of offeringsByName.values()) {
    console.log(o);
    log.info(
      `  - "${o.name}": ${o.priceValue} USDC, sla=${o.slaMinutes}min — ${o.description}`
    );
  }

  buyer.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind === "message") {
      log.chat(session, entry.from, entry.content);
    } else {
      // Terminal events get handled directly. Empty `availableTools()` for a
      // terminal session would also crash the Claude call below, so we never
      // want to reach the LLM hand-off for these.
      switch (entry.event.type) {
        case "job.completed":
          log.job(session.jobId, "completed");
          log.info("---- transcript ----");
          console.log(await session.toContext());
          log.info("---- end transcript ----");
          await buyer.stop();
          return;
        case "job.rejected": {
          const role = counterpartyRole(session, entry.event.rejector);
          log.job(
            session.jobId,
            `rejected by ${role} ${shortAddr(entry.event.rejector)}: ${entry.event.reason}`
          );
          await buyer.stop();
          return;
        }
        case "job.expired":
          log.job(session.jobId, "expired");
          await buyer.stop();
          return;
        default:
          log.job(session.jobId, `system event: ${entry.event.type}`);
      }
    }

    const tools = toAnthropicTools(session.availableTools());

    // Mirror the seller: surface the picked offering's listed price so the
    // LLM has a concrete anchor for the 20%-off counter-offer instead of
    // negotiating blind. Looked up via `session.job.description`, which
    // `createJobByOfferingName` writes on-chain as the offering name — so
    // this works for both fresh jobs and sessions hydrated from a restart.
    const offeringName = session.job?.description ?? undefined;
    const matched = offeringName ? offeringsByName.get(offeringName) : undefined;
    const rawMessages = await session.toMessages();
    rawMessages.unshift({
      role: "system",
      content: matched
        ? `Current offering: "${matched.name}" — listed price ${matched.priceValue} USDC. Discount target ${(matched.priceValue * 0.8).toFixed(4)} USDC (20% off the listed price).`
        : `Current offering: ${offeringName ?? "(unknown)"} — not in the seller's current catalog.`,
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
      system: SYSTEM_PROMPT,
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

  await buyer.start();
  log.info("ready");

  const shutdown = async (signal: NodeJS.Signals) => {
    log.info(`received ${signal}, shutting down`);
    await buyer.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // ── Restart-safety check ─────────────────────────────────────────────
  // After `start()` the SDK has hydrated sessions for every active job
  // this wallet is on; the LLM dispatcher above will resume each one
  // automatically when the latest entry is replayed. We only need to
  // decide whether to *also* create a new job alongside the resuming
  // ones. Default: no — restarting shouldn't silently pile on jobs.
  const inFlight = buyer.sessions.filter(
    (s) =>
      s.chainId === chain.id &&
      s.roles.includes("client") &&
      !["completed", "rejected", "expired"].includes(s.status)
  );
  if (inFlight.length > 0) {
    log.info(
      `found ${inFlight.length} in-flight job(s) initiated by this wallet:`
    );
    for (const s of inFlight) {
      log.info(
        `  - job ${s.jobId} — status=${s.status}, provider ${shortAddr(
          s.job!.providerAddress
        )}`
      );
    }
    const createNew = await promptYesNo(
      "[buyer-llm] create another job in addition to the resuming one(s)? [y/N] ",
      false
    );
    if (!createNew) {
      log.info(
        "resuming existing job(s); not creating a new one — buyer will stop when the current job reaches a terminal state"
      );
      return;
    }
    log.info("user opted in: creating a new job alongside the resuming one(s)");
  }

  // ── Kickoff: let the LLM pick from the catalog we loaded earlier ────
  let offeringName: string;
  let requirement: Record<string, unknown>;
  try {
    ({ offeringName, requirement } = await pickOfferingWithLlm(
      sellerAgent.offerings
    ));
  } catch (err) {
    log.error("LLM offering pick failed", err);
    await buyer.stop();
    return;
  }
  log.info(
    `LLM picked "${offeringName}" with requirement ${JSON.stringify(
      requirement
    )}`
  );

  try {
    // `createJobByOfferingName` looks up the offering on the seller's
    // registry record, validates `requirement` against its JSON schema,
    // creates the on-chain job (description = offering.name, expiredAt =
    // now + offering.slaMinutes), and posts the requirement as the first
    // chat message. The seller will then read the offering name straight
    // off `session.job.description` and quote its registered priceValue.
    const jobId = await buyer.createJobByOfferingName(
      chain.id,
      offeringName,
      sellerAgent.walletAddress,
      requirement,
      { evaluatorAddress: buyerAddress }
    );
    log.job(jobId.toString(), "created — waiting for seller");
  } catch (err) {
    log.error("createJobByOfferingName failed", err);
    await buyer.stop();
  }
}

// ---------------------------------------------------------------------------
// Kickoff helper: ask the LLM to choose one of the seller's offerings and
// build a requirement payload that conforms to its requirements schema.
//
// We use `tool_choice: { type: "tool", name: "createJob" }` to force the
// model to emit a structured `{ offeringName, requirement }` answer rather
// than freeform text — the requirement is then validated by
// `createJobByOfferingName` against the offering's JSON schema, so a
// hallucinated shape will surface as a thrown error rather than silently
// creating a malformed job.
// ---------------------------------------------------------------------------

async function pickOfferingWithLlm(
  offerings: AcpAgentOffering[]
): Promise<{ offeringName: string; requirement: Record<string, unknown> }> {
  const catalog = offerings.map((o) => ({
    name: o.name,
    description: o.description,
    priceValue: o.priceValue,
    slaMinutes: o.slaMinutes,
    requiredFunds: o.requiredFunds,
    requirements: o.requirements,
  }));

  const createJobTool = {
    name: "createJob",
    description:
      "Create a new job by choosing one of the seller's offerings. " +
      "`offeringName` must exactly match one of the offering names from the catalog. " +
      "`requirement` must satisfy the chosen offering's `requirements` JSON schema.",
    input_schema: {
      type: "object" as const,
      properties: {
        offeringName: {
          type: "string",
          description: "Exact name of the offering to use",
        },
        requirement: {
          type: "object",
          description:
            "Requirement payload conforming to the chosen offering's requirements schema",
        },
      },
      required: ["offeringName", "requirement"],
    },
  };

  const response = await anthropic.messages.create({
    model: "gemini-3.1-flash-lite-preview",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content:
          `Seller offerings catalog:\n${JSON.stringify(catalog, null, 2)}\n\n` +
          `Pick the best offering for your goal and call the createJob tool ` +
          `with its exact name and a matching requirement payload.`,
      },
    ],
    tools: [createJobTool],
    tool_choice: { type: "tool", name: "createJob" },
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("LLM did not call the createJob tool");
  }
  const input = block.input as {
    offeringName?: string;
    requirement?: Record<string, unknown>;
  };
  if (!input.offeringName) throw new Error("LLM omitted offeringName");
  if (!input.requirement) throw new Error("LLM omitted requirement");
  return {
    offeringName: input.offeringName,
    requirement: input.requirement,
  };
}

main().catch(console.error);
