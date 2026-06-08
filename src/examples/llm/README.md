# LLM example — Claude-driven buyer and seller

Both sides are driven by an LLM (Anthropic Claude) using the SDK's tool
integration. Instead of hand-coded `case "budget.set":` branches, every
incoming entry is fed to Claude, which picks a tool to call. The SDK then
executes the chosen tool against the session.

## What it shows

- `session.availableTools()` — role- and status-gated tool definitions ready
  to feed into a tool-using LLM.
- `session.toMessages()` — the conversation history flattened into a
  `{ role, content }[]` shape suitable for chat-completion APIs.
- `session.executeTool(name, args)` — runs the tool the LLM picked, dispatching
  to the appropriate `setBudget` / `fund` / `submit` / `complete` / `reject` /
  `sendMessage` / `wait` method (`wait` is a no-op fallback so `tool_choice:
  "any"` always has a valid option).

## How the loop works

```ts
agent.on("entry", async (session, entry) => {
  const tools = session.availableTools();      // gated by role + status
  const messages = await session.toMessages(); // history → chat format

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-…",
    system: "You are a … agent",
    messages: formatMessages(messages),
    tools: formatTools(tools),
    tool_choice: { type: "any" },
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (toolUse) {
    await session.executeTool(toolUse.name, toolUse.input as Record<string, unknown>);
  }
});
```

Both `buyer.ts` and `seller.ts` are minor variations of this loop with
different system prompts — the seller is told it sells memes for 0.01–0.1 USDC,
the buyer is told it wants to buy a funny cat meme.

## Files

| File           | Role                                              |
| -------------- | ------------------------------------------------- |
| `buyer.ts`     | Buyer agent driven by Claude                      |
| `seller.ts`    | Seller agent driven by Claude                     |

## Setup

1. **Install the Anthropic SDK** — it's not a dependency of this package.

   ```bash
   npm install @anthropic-ai/sdk
   ```

2. **Set the API key + wallet env vars** — these examples share `.env` with
   the `basic/` examples. Add to your `.env` (see
   [examples README — shared setup](../README.md#shared-setup)):

   ```
   BUYER_WALLET_ADDRESS=0x…
   BUYER_WALLET_ID=…
   BUYER_SIGNER_PRIVATE_KEY=MIGH…
   SELLER_WALLET_ADDRESS=0x…
   SELLER_WALLET_ID=…
   SELLER_SIGNER_PRIVATE_KEY=MIGH…
   ANTHROPIC_API_KEY=sk-ant-…
   ```

   The buyer also reads `SELLER_WALLET_ADDRESS` to know which provider to
   target with `createJob`.

## Run

```bash
# Terminal 1
npx tsx src/examples/llm/seller.ts

# Terminal 2
npx tsx src/examples/llm/buyer.ts
```

## Available tools by role + status

Reference for the system prompt — these are the tools the LLM has access to
at each step. The SDK gates the list automatically; you don't need to filter.

| Role      | Status       | Tools                              |
| --------- | ------------ | ---------------------------------- |
| Provider  | `open`       | `setBudget`, `sendMessage`, `wait` |
| Provider  | `budget_set` | `setBudget`                        |
| Provider  | `funded`     | `submit`                           |
| Client    | `open`       | `sendMessage`, `wait`              |
| Client    | `budget_set` | `sendMessage`, `fund`, `wait`      |
| Evaluator | `submitted`  | `complete`, `reject`               |

## Notes

- The LLM may pick `wait` when it's not its turn to act — that's a no-op tool
  that exists specifically so `tool_choice: "any"` always has a valid option.
- `formatTools` / `formatMessages` are inline helpers in each file that
  translate between the SDK's `AcpTool` shape and Anthropic's tool definition
  schema. Swap these out (and the model client) to use a different LLM.
- For a deeper writeup, see the main [README — LLM Integration](../../../README.md#llm-integration)
  section.
