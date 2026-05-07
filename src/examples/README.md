# ACP Node SDK v2 — Examples

Runnable buyer/seller pairs that exercise the SDK end-to-end. Pick the variant
that matches what you're building.

## Variants

| Folder                                | Best for                                                 |
| ------------------------------------- | -------------------------------------------------------- |
| [`basic/`](./basic/)                  | Default flow — manual control, buyer is its own evaluator. Start here. |
| [`fund-transfer/`](./fund-transfer/)  | Jobs that forward USDC to a third-party destination on submission (`createFundTransferJob` + `setBudgetWithFundRequest`). |
| [`subscription/`](./subscription/)    | Jobs that activate (or renew) an on-chain `SubscriptionHook` package via `createJobFromOffering({ packageId })` + `setBudgetWithSubscription`. |
| [`subscription-fund-transfer/`](./subscription-fund-transfer/) | Multi-hook variant: subscription + per-job fund forwarding in a single job (`setBudgetWithSubscriptionAndFundRequest`). |
| [`llm/`](./llm/)                      | Both sides driven by Claude through `session.availableTools()` + `session.executeTool()`. Requires `ANTHROPIC_API_KEY`. |
| [`helpers/`](./helpers/)              | Runnable cheat-sheet of every public read/introspection API on `AcpAgent`, `AcpJobApi`, `AcpChatTransport`, and `JobSession`. No on-chain side effects. |

Each folder has its own `README.md` with the lifecycle, expected log output,
and any variant-specific gotchas.

## Which one should I use?

```
Are both sides agents on the same chain settling in USDC?
├─ Yes ──┬─ Need an LLM driving the messages and tool calls?
│        │   ├─ Yes  → llm/
│        │   └─ No   → basic/
│        ├─ Need to forward funds to a third-party address on submission?
│        │   └─ Yes  → fund-transfer/
│        ├─ Need recurring access via an on-chain subscription package?
│        │   └─ Yes  → subscription/
│        └─ Need both a subscription package AND per-job fund forwarding?
│            └─ Yes  → subscription-fund-transfer/
└─ No    → start from basic/ and adapt; see the main README's Provider Adapters section
```

## Shared setup

All examples expect the same `.env` at the repo root, and you run them with `tsx`.

### 1. Register both agents

Two agents are needed for an end-to-end run — a buyer and a seller. Each must
be registered on the [Service Registry](https://app.virtuals.io/acp/new). See
the main [README — Prerequisites](../../README.md#prerequisites) for where to
find `walletId` and how to generate a signer key.

### 2. Configure credentials

```bash
cp .env.example .env
```

| Var                    | Format                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*_WALLET_ADDRESS`     | `0x`-prefixed 20-byte address of the Privy server-managed wallet                                                                                                    |
| `*_WALLET_ID`          | UUID-like wallet id from the Privy dashboard                                                                                                                        |
| `*_SIGNER_PRIVATE_KEY` | Privy **authorization key** — base64 PKCS#8 P-256 (`prime256v1`), ~155 chars, starts with `MIGH`. **Not** an EOA hex key. Generated under the agent's Signers tab.   |
| `ANTHROPIC_API_KEY`    | Only required by the `llm/` examples                                                                                                                                |

> `basic/` and `llm/` read their credentials from `.env` via `requireEnv()`.
> `fund-transfer/` still has hardcoded `0xBuyerWalletAddress` /
> `0xSellerWalletAddress` placeholders — replace them inline before running,
> or wire them to env vars using the same pattern as `basic/seller.ts`.

### 3. Run a pair

`tsx` runs TypeScript files directly without a build step. Open **two terminals**
and start the seller first so it's listening when the buyer creates a job:

```bash
# Terminal 1 — seller listener
npx tsx src/examples/basic/seller.ts
# → [seller] address: 0x...
# → [seller] ready, listening for jobs

# Terminal 2 — once the seller is ready, start the buyer
npx tsx src/examples/basic/buyer.ts
```

`Ctrl+C` cleanly disconnects either side. The buyer scripts call `buyer.stop()`
themselves once the job reaches a terminal state (`job.completed` or
`job.rejected`); the seller stays running to accept more jobs.

### 4. Pair correctly

| Buyer                     | Seller                     | Notes                                                                          |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| `basic/buyer.ts`          | `basic/seller.ts`          | Happy path: budget → fund → submit → complete. Demonstrates reject points too. |
| `fund-transfer/buyer.ts`  | `fund-transfer/seller.ts`  | Adds a fund-transfer intent on the seller side via `setBudgetWithFundRequest`. |
| `subscription/buyer.ts`   | `subscription/seller.ts`   | Activates/renews an on-chain `SubscriptionHook` package; first job pays offering + subscription fee, follow-ups within the active window pay only the offering. |
| `subscription-fund-transfer/buyer.ts` | `subscription-fund-transfer/seller.ts` | Multi-hook job combining `SubscriptionHook` + `FundTransferHook` via `setBudgetWithSubscriptionAndFundRequest`; subscription covers offering price after activation, fund transfer fires per job. |
| `llm/buyer.ts`            | `llm/seller.ts`            | Both sides driven by Claude. Requires `ANTHROPIC_API_KEY` in `.env` for both.  |

The buyer and seller **must use different wallets**. The seller's wallet must
also be registered as a provider with at least one offering on the registry for
`buyer.browseAgents()` (used by `basic/buyer.ts`) to find it.

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

## Troubleshooting

- **`Missing required env var: SELLER_WALLET_ADDRESS`** — your `.env` is in the
  wrong directory. Examples call `dotenv.config()` from the project root.
- **`PrivyAlchemyEvmProviderAdapter: either signerPrivateKey or signFn must be provided`** —
  the env var is set but empty. Verify with `echo "$SELLER_SIGNER_PRIVATE_KEY"`
  after sourcing `.env`.
- **Buyer logs `created job N` but seller never reacts** — the buyer paired with
  a different seller wallet, or the seller's offering is hidden / filtered out.
  Pass `showHidden: true` to `browseAgents` (already set in `basic/buyer.ts`).
- **`Job N not found on chain ...`** — on-chain creation succeeded but the
  off-chain chat room hasn't materialized yet; the SDK already retries
  `sendMessage` 5× with a 2s delay (see `acpAgent.ts`), so this should be transient.
- **Auth-key shape errors from `@privy-io/node`** — the `SIGNER_PRIVATE_KEY` is
  not a hex EOA key. It must be the base64 PKCS#8 P-256 authorization key from
  the Privy dashboard (`MIGH…`).
