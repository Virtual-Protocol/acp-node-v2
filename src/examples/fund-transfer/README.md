# Fund-transfer example

Demonstrates jobs where the buyer's funded amount is split: part of it
pays the seller (the budget), and part of it is forwarded to a separate
on-chain destination on submission. The classic use case is a buyer asking
a seller to execute an on-chain action that requires moving USDC to a third
address (e.g. routing a payment through a service).

## What it shows

- `agent.createFundTransferJob(...)` instead of plain `createJob`.
- `session.setBudgetWithFundRequest(budget, transferAmount, destination)` on
  the seller side — encodes a `FundIntent` so the on-chain hook splits the
  funded amount on submission.
- Same event-driven lifecycle as `basic/`, but with the fund-transfer hook
  wired into the contract calls.

## Lifecycle

```
buyer                                            seller
─────                                            ──────
createFundTransferJob()
    │   ▶ job.created   ──────────────────────▶  case "job.created"
    │                                            (parses requirement message)
    │                                            setBudgetWithFundRequest(
    │                                              budget,
    │                                              transferAmount,
    │                                              destination
    │                                            )
    │   ◀──────────  budget.set  ◀──────────
case "budget.set"
session.fund()
    │   ──────────▶  job.funded   ───────────▶   case "job.funded"
    │                                            session.submit(...)
    │                                            (hook forwards `transferAmount`
    │                                             to `destination` automatically)
    │   ◀──────────  job.submitted ◀────────
case "job.submitted"
session.complete()
```

## Files

| File           | Role                                                                |
| -------------- | ------------------------------------------------------------------- |
| `buyer.ts`     | Creates a fund-transfer job and funds the proposed budget           |
| `seller.ts`    | Sets budget with a fund-request intent, then submits the deliverable |

## Run

These examples currently have hardcoded `0xBuyerWalletAddress` /
`0xSellerWalletAddress` placeholders inside `main()`. Replace them inline
before running, or wire them to env vars using the same `requireEnv()`
pattern as `basic/seller.ts`.

```bash
# Terminal 1
npx tsx src/examples/fund-transfer/seller.ts

# Terminal 2
npx tsx src/examples/fund-transfer/buyer.ts
```

## Key API surface

```ts
// Buyer
const jobId = await buyer.createFundTransferJob(base.id, {
  providerAddress: SELLER_ADDRESS,
  evaluatorAddress: buyerAddress,
  expiredAt: Math.floor(Date.now() / 1000) + 3600,
  description: "Example job from SDK",
});

// Seller
await session.setBudgetWithFundRequest(
  AssetToken.usdc(0.1, session.chainId),    // job budget (paid to seller)
  AssetToken.usdc(0.022, session.chainId),  // amount forwarded to destination
  destinationAddress as `0x${string}`,
);
```

## Notes & gotchas

- The fund-transfer hook address is chain-specific. The SDK looks it up from
  `ACP_CONTRACT_ADDRESSES`; you don't need to plumb it through manually.
- The seller's `destination` is **not** their own wallet by default. In the
  example, `sellerAddress` is passed as the destination for illustration —
  point it at the real receiving address you intend to forward funds to.
- The buyer's `session.fund()` call (no args) handles both the budget
  approval **and** the fund-request encoding automatically. You must call
  `session.fetchJob()` once before `fund()` so the off-chain job record
  (which carries the fund intent) is loaded.
- See the main [README — Fund Transfer Jobs](../../../README.md#fund-transfer-jobs)
  section for a higher-level overview.
