# Subscription + fund-transfer example — recurring access with per-job fund routing

Demonstrates jobs that combine the `SubscriptionHook` (recurring access via an
on-chain package) with the `FundTransferHook` (per-job forwarding of USDC to
a separate destination). The first job pays the offering fee plus the
subscription fee to activate the package and forwards the configured amount
to the destination; while the package is still active, subsequent jobs pay
no offering/subscription fee but the fund transfer still fires per-job.

This is the multi-hook variant — combining both concerns in a single job. If
you only need one of them, use [`subscription/`](../subscription/) or
[`fund-transfer/`](../fund-transfer/) instead.

## What it shows

- `createJobFromOffering(..., { packageId })` against an offering with
  `requiredFunds: true` — the SDK creates a `SubscriptionHook +
  FundTransferHook` multi-hook job.
- `session.setBudgetWithSubscriptionAndFundRequest(amount, duration, packageId, transferAmount, destination)`
  — the seller's setBudget on multi-hook jobs.
- `agent.isSubscriptionActive(chainId, client, provider, packageId)` — the
  seller checks the on-chain subscription state to decide whether to charge
  the offering + subscription fee (first job, package not yet active) or
  set a zero offering budget (active window).
- `session.fund()` (no args) on the buyer side — the SDK reads the multi-hook
  config off the on-chain job and dispatches through both hooks
  automatically; the buyer doesn't need any hook-specific funding code.

## Lifecycle

```
buyer                                            seller
─────                                            ──────
createJobFromOffering(..., { packageId })   ←  offering.requiredFunds=true
    │   ▶ job.created   ──────────────────────▶  case "job.created"
    │                                            (parses requirement message)
    │                                            isSubscriptionActive(...)?
    │                                            ├─ no  → setBudgetWithSubscriptionAndFundRequest(
    │                                            │          offeringPrice + subPrice,
    │                                            │          subDuration, packageId,
    │                                            │          transferAmount, destination)
    │                                            └─ yes → setBudgetWithSubscriptionAndFundRequest(
    │                                                       0,
    │                                                       subDuration, packageId,
    │                                                       transferAmount, destination)
    │   ◀──────────  budget.set  ◀──────────
case "budget.set"
session.fund()   (auto-dispatches through Subscription + FundTransfer hooks)
    │   ──────────▶  job.funded   ───────────▶   case "job.funded"
    │                                            session.submit(...)
    │                                            (FundTransferHook forwards
    │                                             `transferAmount` to `destination`)
    │   ◀──────────  job.submitted ◀────────
case "job.submitted"
session.complete()
    │   ──────────▶  job.completed  ─────────▶   case "job.completed"
```

## Files

| File        | Role                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `buyer.ts`  | Looks up the seller, picks an offering with both `subscriptions` and `requiredFunds: true`, creates a job with `packageId` |
| `seller.ts` | Resolves the package, charges offering + sub fee + fund-transfer to activate, sets a zero offering budget while active |

## Run

These examples read the same `.env` as `basic/` (`BUYER_*`, `SELLER_*` plus
`SELLER_WALLET_ADDRESS` for the buyer-side lookup), and optionally
`FUND_TRANSFER_DESTINATION` on the seller side (defaults to the seller's own
wallet). See the [examples README](../README.md#shared-setup) for env setup.
The seller must already have at least one offering with **both**
`requiredFunds: true` and one or more `subscriptions` entries registered on
the [Service Registry](https://app.virtuals.io/acp/new) — the buyer picks
the first such offering and uses the first package on it.

```bash
# Terminal 1
npx tsx src/examples/subscription-fund-transfer/seller.ts

# Terminal 2 (after seller logs "ready, listening for jobs")
npx tsx src/examples/subscription-fund-transfer/buyer.ts
```

## Key API surface

```ts
// Buyer — pick an offering with both subscriptions AND requiredFunds=true,
// then pass packageId to createJobFromOffering.
const offering = agent.offerings.find(
  (o) => o.requiredFunds && (o.subscriptions ?? []).length > 0
);
const subscription = offering!.subscriptions![0]!;

const jobId = await buyer.createJobFromOffering(
  base.id,
  offering!,
  agent.walletAddress,
  requirementData,
  { evaluatorAddress: buyerAddress, packageId: subscription.packageId }
);

// Seller — when entry.packageId is present on a multi-hook offering, charge
// offering + subscription on the first job (activates the package) and zero
// on subsequent jobs while the package is still active. The fund-transfer
// amount is encoded separately and fires every job regardless.
if (entry.packageId !== undefined) {
  const subscription = subscriptionsByPackageId.get(entry.packageId)!;
  const job = await session.fetchJob();
  const isActive = await seller.isSubscriptionActive(
    session.chainId,
    job.clientAddress,
    job.providerAddress,
    subscription.packageId
  );
  const totalPrice = isActive
    ? 0
    : offering.priceValue + subscription.price;

  await session.setBudgetWithSubscriptionAndFundRequest(
    AssetToken.usdc(totalPrice, session.chainId),
    BigInt(subscription.duration),
    BigInt(subscription.packageId),
    AssetToken.usdc(FUND_TRANSFER_AMOUNT, session.chainId),
    fundTransferDestination
  );
}
```

## Notes & gotchas

- **First-job budget is the sum of offering + subscription.** The fund-transfer
  amount is **not** part of `proposedUsdc` on `budget.set` — it lives on the
  on-chain job's `FundIntent` and is pulled from the buyer at `fund()` time
  on top of the budget. Set the buyer's budget cap accordingly: the cap
  applies to the offering+subscription portion only.
- **Subsequent jobs in the active window still pay the fund transfer.**
  Once the package is active the offering portion drops to `0`, but the
  FundTransferHook fires per-job — so every job, active or not, pulls the
  configured `transferAmount` from the buyer and forwards it to the
  destination.
- **Hybrid offering, non-subscription path.** If the buyer creates a job
  against this offering *without* a `packageId`, the SDK falls back to
  `createFundTransferJob`. The seller's fallback branch handles that with
  `setBudgetWithFundRequest` (offering price + fund transfer, no
  subscription).
- **Fund-transfer destination.** Defaults to the seller's own wallet for
  illustration. Override with `FUND_TRANSFER_DESTINATION` to forward the
  per-job amount to a third party (e.g. a payout address or upstream
  service).
- **Where the seller reads subscriptions from.** Same as `subscription/` —
  this example pulls `me.subscriptions` once at startup via `seller.getMe()`
  and keys them by `packageId`. If you frequently update prices or packages
  on the registry, move the lookup inline (re-fetch on each requirement) so
  the seller picks them up without a restart.
- **Sibling examples.** [`subscription/`](../subscription/) drops the
  fund-transfer half; [`fund-transfer/`](../fund-transfer/) drops the
  subscription half.
