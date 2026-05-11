# Fund-transfer example

Demonstrates jobs where the buyer's funded amount is split: part of it pays
the seller (the budget), and part of it is forwarded to a separate on-chain
destination on submission. Same **event-driven `entry` lifecycle** as
[`basic/`](../basic/README.md). The buyer uses **`createJobFromOffering`** with
an offering where **`requiredFunds` is true** (the SDK selects the fund-transfer
hook on-chain).

## Semantics parity with `basic/`

Both buyer and seller include:

- Header comments describing lifecycle, **evaluator modes** (self-eval via
  `evaluatorAddress: buyerAddress`), and **restart safety** (hydrated sessions
  replay `budget.set` / `job.submitted`).
- **`promptYesNo`** on the buyer before creating a **new** job when in-flight
  client sessions exist (avoids stacking jobs after Ctrl+C).
- Full system branches: `budget.set`, `job.submitted`, `job.completed`
  (transcript via `session.toContext()`), `job.rejected`, `job.expired`.
- **SIGINT / SIGTERM** shutdown on the buyer; seller stops cleanly on signal.
- Seller **reject-with-detail** (`sendMessage` then `reject`) for malformed or
  unsupported requirements.

## Registry setup

1. Register the seller with at least one offering where **`requiredFunds` is true**.
2. Optionally set **`FUND_TRANSFER_OFFERING_NAME`** to select that offering by name;
   otherwise the first `requiredFunds` offering is used.
3. Default requirement shape (**`FUND_TRANSFER_DEMO=plain`**): `{ description, forwardUsdc }`.
   The seller reads **`forwardUsdc`** (or **`transferUsdc`**) for the forward slice.

## Structured sample requirements

Set **`FUND_TRANSFER_DEMO`** to `swap`, `open`, or `close` when your registry
offering is named **`swap_token`**, **`open_position`**, or **`close_position`**
respectively. The buyer sends the JSON from [`jobTypes.ts`](./jobTypes.ts).
The seller parses the requirement and calls `setBudgetWithFundRequest` using the
rules in `seller.ts`.

## Lifecycle

```
buyer                                            seller
─────                                            ──────
createJobFromOffering()  (requiredFunds → fund-transfer job + requirement)
    │   ▶ job.created   ──────────────────────▶  case "job.created"
    │                                            setBudgetWithFundRequest(...)
    │   ◀──────────  budget.set  ◀──────────
case "budget.set"
session.fetchJob(); session.fund()
    │   ──────────▶  job.funded   ───────────▶   case "job.funded"
    │                                            session.submit(...)
    │   ◀──────────  job.submitted ◀────────
case "job.submitted"
session.complete()
case "job.completed" → transcript, stop
```

## Files

| File | Role |
| ---- | ---- |
| `buyer.ts` | `getAgentByWalletAddress`, `createJobFromOffering`, fund, evaluate |
| `seller.ts` | Registry match, structured samples, documentation example string; `setBudgetWithFundRequest` |
| `jobTypes.ts` | Structured requirement types, parsers, and sample bodies |

## Run

Same `.env` as [`basic/`](../basic/README.md) (`BUYER_*`, `SELLER_*`). Start
**seller first**, then buyer:

```bash
npx tsx src/examples/fund-transfer/seller.ts
npx tsx src/examples/fund-transfer/buyer.ts
```

## Environment variables

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `FUND_TRANSFER_DEMO` | `plain` | `plain` \| `swap` \| `open` \| `close` — requirement shape; structured values require a matching offering name |
| `FUND_TRANSFER_OFFERING_NAME` | (first `requiredFunds`) | Select offering by registry name |
| `FUND_TRANSFER_DESTINATION` | seller wallet | Forward USDC recipient |
| `FUND_TRANSFER_DEFAULT_FORWARD_USDC` | `0.022` | Default forward slice when not set on the requirement |
| `FUND_TRANSFER_STRUCTURED_FORWARD_USDC` | `0.022` | Forward slice for `swap` / `open` structured samples (no registry row) |
| `FUND_TRANSFER_EXAMPLE_BUDGET_USDC` | `0.1` | Budget when `job.description` matches the documentation example string |
| `FUND_TRANSFER_EXAMPLE_FORWARD_USDC` | `0.022` | Forward slice for that case |
| `FUND_TRANSFER_EXAMPLE_JOB_DESCRIPTION` | (see `jobTypes.ts`) | Override which `job.description` value the seller treats as the doc example |
| `FUND_TRANSFER_CLOSE_BUDGET_USDC` | `0.02` | Budget for `close_position` structured sample |

## Key API surface

```ts
const jobId = await buyer.createJobFromOffering(
  chainId,
  offering, // offering.requiredFunds === true
  agent.walletAddress,
  requirementData,
  { evaluatorAddress: buyerAddress }
);

await session.setBudgetWithFundRequest(
  AssetToken.usdc(budget, session.chainId),
  AssetToken.usdc(transfer, session.chainId),
  destinationAddress
);
```

For **`createFundTransferJob`** (manual job creation without the registry), see
the main [README — Fund Transfer Jobs](../../../README.md#fund-transfer-jobs).

## Notes

- **`setBudget` is invalid** when the job uses `FundTransferHook` — use
  **`setBudgetWithFundRequest`** only (see `JobSession.setBudget`).
- See the main [README — Fund Transfer Jobs](../../../README.md#fund-transfer-jobs).
