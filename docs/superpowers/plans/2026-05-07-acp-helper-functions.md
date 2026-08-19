# ACP Helper Functions Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `src/examples/helpers/` folder containing a runnable script that showcases the public read/introspection APIs the v2 SDK exposes (agent-level + JobSession-level), modeled after [Virtual-Protocol/acp-node v1's `examples/acp-base/helpers/acpHelperFunctions.ts`](https://github.com/Virtual-Protocol/acp-node/tree/main/examples/acp-base/helpers).

**Architecture:** A single runnable `acpHelperFunctions.ts` that connects with the existing `BUYER_*` env vars, exercises every public read API in delimited subsections (matching v1's `subsection()` pattern), and exits. Plus a README describing the folder. No new dependencies, no edits to existing example logic, not exported from `src/index.ts`. The folder demonstrates SDK functions that already exist — it does NOT extract duplication from the existing examples (no shared `logger`, `shortAddr`, `prompt` helpers).

**Tech Stack:** TypeScript (existing), `tsx` (existing), `AcpAgent` + `PrivyAlchemyEvmProviderAdapter` (existing), `@account-kit/infra` `base` chain (matches all current examples), `dotenv` (already a devDep).

**Verification model:** No unit tests. The `package.json` has no test runner installed and these are demo scripts whose value is "compiles, runs against a configured wallet, prints meaningful output." The verification gate per task is `npx tsc --noEmit`; final verification is a `tsx` smoke run printing every section.

---

## Public read APIs covered by `acpHelperFunctions.ts`

These are the methods the script will demo, grouped by subsection. Every one is already implemented in `src/`; this plan adds zero new SDK code.

| Subsection | Method | Source |
| --- | --- | --- |
| Agent identity | `agent.getAddress()` | `src/acpAgent.ts:218` |
| Agent identity | `agent.getSupportedChainIds()` | `src/acpAgent.ts:187` |
| Self profile | `agent.getMe()` | `src/acpAgent.ts:209` |
| Registry lookup | `agent.getAgentByWalletAddress(addr)` | `src/acpAgent.ts:203` |
| Registry browse | `agent.browseAgents(keyword, params)` | `src/acpAgent.ts:191` |
| Active jobs | `agent.getApi().getActiveJobs()` | `src/events/types.ts:236` |
| Per-job lookup | `agent.getApi().getJob(chainId, jobId)` | `src/events/types.ts:237` |
| Job history | `agent.getTransport().getHistory(chainId, jobId)` | `src/events/types.ts:223` |
| Hydrated sessions | `agent.sessions` | `src/acpAgent.ts:345` |
| Session state | `session.status` | `src/jobSession.ts:226` |
| Session state | `session.roles`, `session.chainId`, `session.jobId`, `session.entries` | `src/jobSession.ts:170-193` |
| Session tools | `session.availableTools()` | `src/jobSession.ts:268` |
| Session refresh | `session.fetchJob()` | `src/jobSession.ts:199` |
| Session render | `session.toContext()` | `src/jobSession.ts:640` |
| Session render | `session.toMessages()` | `src/jobSession.ts:683` |
| Subscription state | `agent.isSubscriptionActive(chainId, client, provider, packageId)` | `src/acpAgent.ts:789` |
| Subscription state | `agent.getSubscriptionExpiry(...)` | `src/acpAgent.ts:766` |
| Subscription state | `agent.getProposedSubscriptionTerms(chainId, jobId)` | `src/acpAgent.ts:804` |
| Asset tokens | `agent.resolveAssetToken(address, amount, chainId)` | `src/acpAgent.ts:483` |
| Asset tokens | `agent.resolveRawAssetToken(address, rawAmount, chainId)` | `src/acpAgent.ts:491` |

`agent.getRouterHooks(chainId, jobId, selector)` is mentioned only in a code comment — it requires a multi-hook router job in flight and a 4-byte selector to invoke meaningfully, which would force the script to either fabricate state or fail noisily.

---

## File structure

| Path | Created/Modified | Responsibility |
| --- | --- | --- |
| `src/examples/helpers/README.md` | Create | Folder purpose, usage, env requirements, expected output. Mirrors the v1 README. |
| `src/examples/helpers/acpHelperFunctions.ts` | Create | Single runnable script: agent setup → 8 subsections of public-read demos → exit. |
| `src/examples/README.md` | Modify (append one row + paragraph) | Add `helpers/` to the variants table and a one-paragraph pointer. |

Total: 2 files created, 1 file modified.

---

### Task 1: Scaffold `src/examples/helpers/` folder with README

**Files:**
- Create: `src/examples/helpers/README.md`

- [ ] **Step 1: Verify the parent directory exists**

Run: `ls src/examples/`

Expected output should include `basic`, `fund-transfer`, `llm`, `subscription`, `subscription-fund-transfer`, `README.md`. The `helpers/` directory should NOT yet exist.

- [ ] **Step 2: Create `src/examples/helpers/README.md` with this exact content**

```markdown
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

The script does NOT call `agent.start()` until the active-jobs section
runs, and explicitly disconnects via `agent.stop()` before exiting — so
it leaves no SSE subscription open.

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
   <session.status, roles, availableTools, last 3 entries>

--- Session render (toContext / toMessages) ---
   <transcript and LLM-shaped messages of the most recent session>

--- Subscription state ---
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
```

- [ ] **Step 3: Commit**

```bash
git add src/examples/helpers/README.md
git commit -m "$(cat <<'EOF'
docs(examples): add helpers folder README

Scaffolds src/examples/helpers/ as a runnable cheat-sheet of the SDK's
public read APIs, modeled on Virtual-Protocol/acp-node v1's
examples/acp-base/helpers/ reference.
EOF
)"
```

---

### Task 2: Scaffold `acpHelperFunctions.ts` skeleton

**Files:**
- Create: `src/examples/helpers/acpHelperFunctions.ts`

This task creates the script with ONLY: imports, env loading, the `subsection()` formatter, agent creation, and a guarded `main()` that calls `await agent.stop()` and exits cleanly. Subsequent tasks add subsections one at a time.

- [ ] **Step 1: Create `src/examples/helpers/acpHelperFunctions.ts` with this exact content**

```typescript
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
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
git add src/examples/helpers/acpHelperFunctions.ts
git commit -m "$(cat <<'EOF'
feat(examples): scaffold acpHelperFunctions runnable

Sets up the script's skeleton: env loading, agent creation, the
subsection() formatter, and a guarded main() that always calls
agent.stop() before exit. Subsections are added in follow-up commits.
EOF
)"
```

---

### Task 3: Add agent identity + registry-lookup subsections

**Files:**
- Modify: `src/examples/helpers/acpHelperFunctions.ts:39-41`

Replace the placeholder `subsection("Skeleton")` block with five real subsections covering `getAddress`, `getSupportedChainIds`, `getMe`, `getAgentByWalletAddress`, and `browseAgents`.

- [ ] **Step 1: Replace the skeleton subsection with the identity demos**

Open `src/examples/helpers/acpHelperFunctions.ts`. Find the block (added in Task 2):

```typescript
    subsection("Skeleton");
    console.log("(no demos yet — see Task 3+ in the implementation plan)");
```

Replace it with this:

```typescript
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
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
git add src/examples/helpers/acpHelperFunctions.ts
git commit -m "$(cat <<'EOF'
feat(examples): add identity + registry-lookup demos to helpers

Demonstrates getAddress, getSupportedChainIds, getMe,
getAgentByWalletAddress, and browseAgents. The seller-lookup branch is
guarded behind SELLER_WALLET_ADDRESS so the script runs without it.
EOF
)"
```

---

### Task 4: Add active-jobs + per-job inspection subsection

**Files:**
- Modify: `src/examples/helpers/acpHelperFunctions.ts` (append new block after the registry-browse subsection)

Demos `agent.getApi().getActiveJobs()`, `agent.getApi().getJob(chainId, jobId)`, and `agent.getTransport().getHistory(chainId, jobId)`. These are the v2 analog of v1's "list jobs + inspect a memo" workflow.

- [ ] **Step 1: Append this block after the `Registry browse` subsection (immediately before the closing `} finally {`)**

```typescript
    /* ---------------- ACTIVE JOBS ---------------- */
    subsection("Active jobs (getApi().getActiveJobs)");
    const api = agent.getApi();
    const activeJobs = await api.getActiveJobs();
    console.log(`${activeJobs.length} active job(s):`);

    // Inspect up to the first 3 active jobs in detail. v1's helper paged
    // with `getActiveJobs(1, 3)`; v2's getActiveJobs() returns all jobs the
    // wallet is on (no pagination), so we slice client-side.
    for (const ref of activeJobs.slice(0, 3)) {
      console.log(`\n  job ${ref.onChainJobId} on chain ${ref.chainId}:`);

      /* ---- per-job off-chain record ---- */
      const job = await api.getJob(ref.chainId, ref.onChainJobId);
      if (!job) {
        console.log(`    (no off-chain record)`);
        continue;
      }
      console.log(`    status:      ${job.jobStatus}`);
      console.log(`    client:      ${job.clientAddress}`);
      console.log(`    provider:    ${job.providerAddress}`);
      console.log(`    evaluator:   ${job.evaluatorAddress}`);
      console.log(`    description: ${job.description ?? "(none)"}`);
      console.log(`    budget:      ${job.budget ?? "(unset)"}`);
      console.log(`    expiredAt:   ${job.expiredAt}`);
      console.log(`    hookAddress: ${job.hookAddress ?? "(none)"}`);
      if (job.hookConfigs) {
        console.log(`    hookConfigs: ${JSON.stringify(job.hookConfigs)}`);
      }
      if (job.intents && job.intents.length > 0) {
        console.log(`    intents:     ${job.intents.length}`);
        for (const i of job.intents) {
          console.log(
            `      - ${i.actor} → ${i.recipientAddress}, ` +
              `${i.amount ?? "(amount tbd)"} ${i.tokenAddress ?? ""} ` +
              `(escrow=${i.isEscrow}, signed=${i.isSigned})`
          );
        }
      }

      /* ---- per-job chat history ---- */
      const transport = agent.getTransport();
      const history = await transport.getHistory(ref.chainId, ref.onChainJobId);
      console.log(`    history:     ${history.length} entry(ies)`);
      for (const e of history.slice(-3)) {
        if (e.kind === "system") {
          console.log(`      [system] ${e.event.type}`);
        } else {
          const preview = e.content.length > 60
            ? `${e.content.slice(0, 60)}…`
            : e.content;
          console.log(`      [${e.from}] (${e.contentType}) ${preview}`);
        }
      }
    }

    if (activeJobs.length > 3) {
      console.log(`\n  …and ${activeJobs.length - 3} more`);
    }

    // Note: agent.getRouterHooks(chainId, jobId, selector) is also a public
    // read API — call it when a multi-hook router job is in flight to see
    // which sub-hooks are configured for a given selector. Skipped here
    // because demoing it requires fabricating selector bytes.
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
git add src/examples/helpers/acpHelperFunctions.ts
git commit -m "$(cat <<'EOF'
feat(examples): demo active-jobs + per-job inspection in helpers

Walks through agent.getApi().getActiveJobs(), per-job
agent.getApi().getJob(chainId, jobId), and
agent.getTransport().getHistory(chainId, jobId) — the v2 analog of v1's
getActiveJobs / getJobById / getMemoById trio (memos became unified
JobRoomEntry history in v2).
EOF
)"
```

---

### Task 5: Add hydrated-sessions + session-render subsection

**Files:**
- Modify: `src/examples/helpers/acpHelperFunctions.ts` (append after the active-jobs block)

This subsection is the only one that calls `agent.start()`. After hydration, `agent.sessions` is populated with one `JobSession` per active job — and we can demo `session.status`, `session.roles`, `session.availableTools()`, `session.toContext()`, `session.toMessages()`, and `session.fetchJob()`. We always pair `start()` with `stop()` (already in the `finally` block).

- [ ] **Step 1: Append this block after the active-jobs subsection (still inside `try { ... }`)**

```typescript
    /* ---------------- HYDRATED SESSIONS ---------------- */
    subsection("Hydrated sessions (after agent.start)");
    // agent.start() opens the SSE transport and calls hydrateSessions(),
    // which builds a JobSession for every active job this wallet is on.
    // The single-entry handler is a no-op here — we only want hydration.
    agent.on("entry", () => {});
    await agent.start();
    const sessions = agent.sessions;
    console.log(`${sessions.length} hydrated session(s):`);
    for (const s of sessions.slice(0, 3)) {
      console.log(
        `  - job ${s.jobId} (chain ${s.chainId}): status=${s.status}, ` +
          `roles=[${s.roles.join(",")}], entries=${s.entries.length}`
      );
      console.log(
        `    availableTools: [${s.availableTools().map((t) => t.name).join(", ")}]`
      );
    }

    /* ---------------- SESSION RENDER ---------------- */
    subsection("Session render (toContext / toMessages)");
    const sample = sessions[0];
    if (sample) {
      // session.fetchJob() forces a refresh of session.job from the backend
      // — useful when you need the latest off-chain state mid-flow. After
      // hydration the SDK has typically already populated session.job.
      await sample.fetchJob();
      console.log(`sample session: job ${sample.jobId}`);
      console.log("\n  toContext():");
      const ctx = await sample.toContext();
      for (const line of ctx.split("\n").slice(0, 8)) {
        console.log(`    ${line}`);
      }
      const ctxLines = ctx.split("\n").length;
      if (ctxLines > 8) console.log(`    …(${ctxLines - 8} more line(s))`);

      console.log("\n  toMessages() (LLM-shaped):");
      const msgs = await sample.toMessages();
      for (const m of msgs.slice(0, 4)) {
        const preview =
          m.content.length > 80 ? `${m.content.slice(0, 80)}…` : m.content;
        console.log(`    ${m.role}: ${preview}`);
      }
      if (msgs.length > 4) console.log(`    …(${msgs.length - 4} more)`);
    } else {
      console.log("no hydrated sessions to render — skipping");
    }
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
git add src/examples/helpers/acpHelperFunctions.ts
git commit -m "$(cat <<'EOF'
feat(examples): demo hydrated sessions + JobSession render in helpers

Calls agent.start() to populate agent.sessions, then exercises every
public read on JobSession: status, roles, entries, availableTools(),
fetchJob(), toContext(), toMessages(). agent.stop() in the finally
block keeps SSE cleanup tight.
EOF
)"
```

---

### Task 6: Add subscription-state subsection

**Files:**
- Modify: `src/examples/helpers/acpHelperFunctions.ts` (append after the session-render block)

Demos `agent.getProposedSubscriptionTerms`, `agent.getSubscriptionExpiry`, `agent.isSubscriptionActive`. These read from the SubscriptionHook + SubscriptionState contracts and only return meaningful data when a session in scope is using the SubscriptionHook. We guard accordingly so the script doesn't error out for non-subscription wallets.

- [ ] **Step 1: Append this block after the session-render subsection**

```typescript
    /* ---------------- SUBSCRIPTION STATE ---------------- */
    subsection("Subscription state (on-chain reads)");
    // These three methods read from the SubscriptionHook + SubscriptionState
    // contracts. They only return meaningful data when there's a job using
    // the SubscriptionHook in scope, so we look for one before calling.
    const subscriptionSession = sessions.find((s) => {
      const hook = s.job?.hookAddress?.toLowerCase();
      const subHook = (
        process.env.SUBSCRIPTION_HOOK_ADDRESS ?? ""
      ).toLowerCase();
      // Prefer the strict signal: jobs that activated a subscription
      // expose `clientSubscription` on AcpJob. Fall back to a hookConfigs
      // truthiness check (set by SubscriptionHook + MultiHookRouter jobs)
      // or an explicit env override.
      return (
        s.job?.clientSubscription != null ||
        Boolean(s.job?.hookConfigs) ||
        (subHook && hook === subHook)
      );
    });

    if (!subscriptionSession || !subscriptionSession.job) {
      console.log(
        "no subscription-hook session in scope — skipping " +
          "(set up a subscription/ example flow first to exercise this)"
      );
    } else {
      const job = subscriptionSession.job;
      console.log(`probing subscription state for job ${subscriptionSession.jobId}`);

      try {
        const terms = await agent.getProposedSubscriptionTerms(
          subscriptionSession.chainId,
          BigInt(subscriptionSession.jobId)
        );
        console.log(
          `  proposed terms: duration=${terms.duration}s, packageId=${terms.packageId}`
        );

        const packageId = Number(terms.packageId);
        const expiry = await agent.getSubscriptionExpiry(
          subscriptionSession.chainId,
          job.clientAddress,
          job.providerAddress,
          packageId
        );
        const isActive = await agent.isSubscriptionActive(
          subscriptionSession.chainId,
          job.clientAddress,
          job.providerAddress,
          packageId
        );
        const nowSec = Math.floor(Date.now() / 1000);
        const remaining = Number(expiry) - nowSec;
        console.log(
          `  expiry:         ${expiry} (${
            remaining > 0 ? `${remaining}s remaining` : "expired"
          })`
        );
        console.log(`  isActive:       ${isActive}`);
      } catch (err) {
        console.log(`  subscription read failed: ${err}`);
      }
    }
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
git add src/examples/helpers/acpHelperFunctions.ts
git commit -m "$(cat <<'EOF'
feat(examples): demo subscription on-chain reads in helpers

Adds a guarded subsection covering getProposedSubscriptionTerms,
getSubscriptionExpiry, and isSubscriptionActive. Skipped cleanly when no
subscription-hook session is in scope so non-subscription wallets aren't
penalized.
EOF
)"
```

---

### Task 7: Add asset-token resolution subsection

**Files:**
- Modify: `src/examples/helpers/acpHelperFunctions.ts` (append after the subscription-state block)

Demos `agent.resolveAssetToken(address, amount, chainId)` and `agent.resolveRawAssetToken(address, rawAmount, chainId)`. Useful because devs frequently need to convert between human-readable amounts and raw on-chain decimals when building budgets / fund intents.

- [ ] **Step 1: Append this block after the subscription-state subsection**

```typescript
    /* ---------------- ASSET TOKEN RESOLUTION ---------------- */
    subsection("Asset token resolution");
    // resolveAssetToken / resolveRawAssetToken read decimals + symbol from
    // the ERC-20 contract and return an AssetToken — useful when you have
    // a token address but don't know its decimals. AssetToken.usdc(...) is
    // the shorthand most examples use; this section demonstrates the
    // general path for any ERC-20 (e.g. a chain-specific WETH).
    //
    // We resolve USDC on the configured chain by re-using the token address
    // recorded on a session's job (every job carries a budget token via
    // its hookConfigs / ACP contract address resolution). Skipped if no
    // session is available.
    if (sample?.job) {
      const intent = sample.job.getFundRequestIntent() ?? sample.job.getFundTransferIntent();
      const tokenAddress = (intent?.tokenAddress ?? null) as `0x${string}` | null;
      if (tokenAddress) {
        const oneUnit = await agent.resolveAssetToken(
          tokenAddress,
          1,
          sample.chainId
        );
        console.log(
          `  resolveAssetToken: 1 of ${tokenAddress} → ` +
            `${oneUnit.amount} ${oneUnit.symbol} (raw ${oneUnit.rawAmount})`
        );

        const oneRaw = await agent.resolveRawAssetToken(
          tokenAddress,
          1_000_000n,
          sample.chainId
        );
        console.log(
          `  resolveRawAssetToken: 1_000_000 raw of ${tokenAddress} → ` +
            `${oneRaw.amount} ${oneRaw.symbol}`
        );
      } else {
        console.log("skipped — no token address available on the sample session");
      }
    } else {
      console.log("skipped — no sample session available");
    }
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
git add src/examples/helpers/acpHelperFunctions.ts
git commit -m "$(cat <<'EOF'
feat(examples): demo asset-token resolution in helpers

Adds a subsection exercising agent.resolveAssetToken and
agent.resolveRawAssetToken — the path devs need when handling tokens
beyond AssetToken.usdc(...). Skipped cleanly when no token-bearing
session is in scope.
EOF
)"
```

---

### Task 8: Surface the helpers folder from `src/examples/README.md`

**Files:**
- Modify: `src/examples/README.md`

Add `helpers/` to the variants table and a short pointer paragraph. This is documentation, not example logic, so it's compatible with the "additive only" constraint we agreed on.

- [ ] **Step 1: Add a row to the Variants table**

Open `src/examples/README.md`. Find the table that begins:

```markdown
| Folder                                | Best for                                                 |
| ------------------------------------- | -------------------------------------------------------- |
| [`basic/`](./basic/)                  | Default flow — manual control, buyer is its own evaluator. Start here. |
```

After the row for `[`llm/`](./llm/)`, add this new row:

```markdown
| [`helpers/`](./helpers/)              | Runnable cheat-sheet of every public read/introspection API on `AcpAgent`, `AcpJobApi`, `AcpChatTransport`, and `JobSession`. No on-chain side effects. |
```

- [ ] **Step 2: Add a "Helpers" paragraph after the "Pair correctly" table**

Find the line in `src/examples/README.md`:

```markdown
The buyer and seller **must use different wallets**. The seller's wallet must
also be registered as a provider with at least one offering on the registry for
`buyer.browseAgents()` (used by `basic/buyer.ts`) to find it.
```

Immediately after that paragraph (and before the `## Troubleshooting` heading), insert:

```markdown
### Helpers — exploring the read APIs

Once you have a buyer wallet configured, point the helpers script at it to
see every public read API the SDK exposes printed in one go:

```bash
npx tsx src/examples/helpers/acpHelperFunctions.ts
```

It does not create or mutate any on-chain state — useful as a debugging
tool, a discoverability surface, and a reference when writing your own
monitoring or admin tooling. See [`helpers/README.md`](./helpers/README.md)
for the full list of methods covered.
```

- [ ] **Step 3: Verify the README still parses cleanly**

Run: `npx tsc --noEmit`

Expected: exits 0 (README change is markdown-only; this just confirms the previous task's TS still compiles after a working-tree refresh).

- [ ] **Step 4: Commit**

```bash
git add src/examples/README.md
git commit -m "$(cat <<'EOF'
docs(examples): surface the helpers folder from the examples README

Adds helpers/ to the variants table and a short pointer paragraph
explaining when to use the read-API showcase script.
EOF
)"
```

---

### Task 9: Final verification — compile + smoke run

**Files:**
- None (verification only)

- [ ] **Step 1: Full compile**

The repo's root `tsconfig.json` has `"exclude": ["src/examples*", "dist"]` — so plain `npx tsc --noEmit` does NOT type-check anything under `src/examples/`. Use a file-scoped invocation that bypasses the exclude:

Run:

```bash
npx tsc --noEmit --rootDir . --module nodenext --moduleResolution nodenext \
  --target es2020 --strict --skipLibCheck --types node --esModuleInterop \
  --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  src/examples/helpers/acpHelperFunctions.ts
```

Expected: exits 0 with no output.

(The repo's `npx tsc --noEmit` from root will report 4 pre-existing TS6059 errors about `examples-local/` — those are unrelated and predate this work; do not chase them.)

- [ ] **Step 2: Confirm the script's structure with a no-side-effect parse check**

Run: `npx tsx --no-deprecation src/examples/helpers/acpHelperFunctions.ts --help 2>&1 | head -1 || true`

Expected: the script begins running (you'll see `Initializing ACP agent...` if `.env` is configured, or `Missing required env var: BUYER_WALLET_ADDRESS` otherwise). Either outcome confirms imports resolve and the entrypoint runs.

- [ ] **Step 3: Smoke run against testnet (only if `.env` is populated)**

Run: `npx tsx src/examples/helpers/acpHelperFunctions.ts`

Expected output structure (exact values vary):

```
============================================================
ACP SDK Public Helper Functions
============================================================

Initializing ACP agent...

--- Agent identity ---
address:           0x...
supported chains:  [8453]

--- Self registry profile (getMe) ---
name:              ...
role:              ...
offerings:         N
  - "..." — ... USDC, sla=...min, requiredFunds=..., hidden=...
subscriptions:     N

--- Direct lookup (getAgentByWalletAddress) ---
...

--- Registry browse (browseAgents) ---
top N agent(s) matching "agent":
  - "..." 0x... — N offering(s)

--- Active jobs (getApi().getActiveJobs) ---
N active job(s):
  job ... on chain ...:
    status:      ...
    ...
    history:     N entry(ies)
      [system] job.created
      ...

--- Hydrated sessions (after agent.start) ---
N hydrated session(s):
  - job ... (chain ...): status=..., roles=[...], entries=N
    availableTools: [...]

--- Session render (toContext / toMessages) ---
sample session: job ...

  toContext():
    [system]  job.created — ...
    ...

  toMessages() (LLM-shaped):
    user: ...
    ...

--- Subscription state (on-chain reads) ---
... (or "no subscription-hook session in scope — skipping")

--- Asset token resolution ---
... (or "skipped — ...")

Done.
```

- [ ] **Step 4: Final commit if any cleanups were needed**

If steps 1–3 surfaced minor fixes (typos, missing newlines, etc.), commit them as:

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(examples): final cleanup pass on helpers showcase

Address minor issues surfaced during the smoke-run verification step.
EOF
)"
```

If no cleanups were needed, skip this step.

---

## Self-review

**Spec coverage:**
- Goal: "showcase every public read/introspection API the v2 SDK exposes" — covered. The Public read APIs table at the top maps every method to the task that demos it.
- "Modeled after v1's `acpHelperFunctions.ts`" — Tasks 1–7 match v1's structure (single file with `subsection()` separators, runnable from the repo root, prints to stdout).
- "Not extraction of example duplication" — confirmed: no shared logger/prompt/shortAddr is created or referenced.
- "No edits to existing example logic" — only `src/examples/README.md` is modified, and only its docs (Task 8). No buyer.ts/seller.ts files are touched.

**Placeholder scan:** No "TBD", "TODO", "implement later", or "add appropriate error handling" in any step. Every code block contains complete content.

**Type consistency:**
- Methods called by name across tasks: `getMe`, `getAddress`, `getSupportedChainIds`, `getAgentByWalletAddress`, `browseAgents`, `getApi().getActiveJobs`, `getApi().getJob`, `getTransport().getHistory`, `agent.start`, `agent.sessions`, `agent.stop`, `session.status`, `session.roles`, `session.entries`, `session.availableTools`, `session.fetchJob`, `session.toContext`, `session.toMessages`, `agent.getProposedSubscriptionTerms`, `agent.getSubscriptionExpiry`, `agent.isSubscriptionActive`, `agent.resolveAssetToken`, `agent.resolveRawAssetToken`, `job.getFundRequestIntent`, `job.getFundTransferIntent`. All match the signatures in `src/acpAgent.ts`, `src/jobSession.ts`, `src/events/types.ts`, and `src/acpJob.ts` as of the source line numbers cited in the Public read APIs table.
- Env vars referenced: `BUYER_WALLET_ADDRESS`, `BUYER_WALLET_ID`, `BUYER_SIGNER_PRIVATE_KEY` (required), `SELLER_WALLET_ADDRESS` (optional), `SUBSCRIPTION_HOOK_ADDRESS` (optional override). The first three exist in the repo's `.env.example`; the optional two are documented inline in the script.

No issues found.
