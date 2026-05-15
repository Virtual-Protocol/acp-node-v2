# Helpers — SDK public-read API showcase

A runnable cheat-sheet of every public read/introspection method the v2 SDK
exposes on `AcpAgent`, `AcpJobApi`, `AcpChatTransport`, and `JobSession`.

## Purpose

The `basic/`, `fund-transfer/`, `llm/`, `subscription/`, and
`subscription-fund-transfer/` examples each demonstrate **one full lifecycle**.
They don't surface most of the SDK's read APIs because a single happy-path
flow doesn't need them.

This folder fills that gap: a single script that calls every public
read/introspection method against a configured wallet so devs can:

- Discover methods they didn't know exist (e.g. `agent.getMe()`,
  `agent.isSubscriptionActive(...)`, `session.toMessages()`).
- See the exact return-value shape printed to stdout, instead of inferring
  from TypeScript types.
- Use it as a debugging tool — point it at a wallet and see what the
  registry, off-chain backend, and on-chain subscription state contracts
  all think about that wallet's jobs and offerings.

This folder does **not** extract or wrap any of the example code. The
patterns in `basic/buyer.ts` etc. (`shortAddr`, `counterpartyRole`, `log`,
`requireEnv`, `promptYesNo`, ...) are intentionally inlined per-example so
each file is independently readable. They're not promoted here.

## What's included

- `acpHelperFunctions.ts` — runnable script (this is the whole demo).

## When to use

- First time exploring the SDK — read it top to bottom, then run it.
- Debugging an integration — uncomment the section closest to your
  problem and re-run to print the on-chain / registry state.
- As a reference when writing your own monitoring or admin tooling —
  every method called here is a public, supported API.

## How to run

The script reads the same `BUYER_*` env vars as `basic/buyer.ts`:

```bash
# from the repo root, with .env populated
npx tsx src/examples/helpers/acpHelperFunctions.ts
```

If `SELLER_WALLET_ADDRESS` is set, the script will also exercise the
`getAgentByWalletAddress` lookup against that address. Otherwise that
subsection is skipped with a note.

The script does NOT call `agent.start()` until the hydrated-sessions
section runs, and explicitly disconnects via `agent.stop()` before
exiting — so it leaves no SSE subscription open.

## Type-checking

The repo's root `tsconfig.json` excludes `src/examples*` from the SDK
build, so `npx tsc --noEmit` does NOT type-check this file. Run a
file-scoped check before committing changes here:

```bash
npx tsc --noEmit --rootDir . --module nodenext --moduleResolution nodenext \
  --target es2020 --strict --skipLibCheck --types node --esModuleInterop \
  --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  src/examples/helpers/acpHelperFunctions.ts
```

Expected: exits 0 with no output.

## Expected output sections

```
============================================================
ACP SDK Public Helper Functions
============================================================

--- Agent identity ---
   address: 0x...
   supported chains: [8453]

--- Self registry profile (getMe) ---
   <agent name, offerings, subscriptions, ...>

--- Direct lookup (getAgentByWalletAddress) ---
   <seller agent record, or "skipped — SELLER_WALLET_ADDRESS not set">

--- Registry browse (browseAgents) ---
   <top 3 agents matching the keyword>

--- Active jobs (getApi().getActiveJobs) ---
   <up to 3 jobs, each with full off-chain record + chat history>

--- Hydrated sessions (after agent.start) ---
   <per-session: status, roles, entries-count, availableTools>

--- Session render (toContext / toMessages) ---
   <transcript and LLM-shaped messages of the most recent session>

--- Subscription state (on-chain reads) ---
   <expiry, isActive — only printed when a subscription hook is in play>

--- Asset token resolution ---
   <resolveAssetToken / resolveRawAssetToken examples>
```

## Limitations

- **No memo APIs.** v2 has no `getMemoById` / `getPendingMemoJobs` (memos
  were folded into the unified `JobRoomEntry` stream). Use
  `transport.getHistory(...)` or `session.entries` instead — both are
  demoed below.
- **`getCompletedJobs` / `getCancelledJobs` are not on `AcpJobApi`.** Only
  `getActiveJobs` is exposed. Filtering by terminal status from the
  backend would require a backend addition.
- **`getRouterHooks` is mentioned but not invoked.** It requires a
  multi-hook router job and a 4-byte selector to be useful; see the
  inline comment in `acpHelperFunctions.ts` for the call shape.
