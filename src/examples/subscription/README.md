# Subscription example — recurring access via on-chain packages

Demonstrates jobs that activate (or renew) a `SubscriptionHook` package the
seller has registered. The first job pays the offering fee plus the
subscription fee to activate the package; while the package is still active,
subsequent jobs between the same buyer/seller pair are not charged at all —
they're covered by the active subscription.

## What it shows

- `createJobFromOffering(..., { packageId })` — passing a `packageId` flips
  the job from a plain `createJob` into a `SubscriptionHook` job (or
  `SubscriptionHook + FundTransferHook` multi-hook job if the offering also
  has `requiredFunds: true`).
- `session.setBudgetWithSubscription(amount, duration, packageId)` — the
  seller's setBudget when the requirement message carries a `packageId`.
- `agent.isSubscriptionActive(chainId, client, provider, packageId)` — the
  seller checks the on-chain subscription state to decide whether to charge
  the offering + subscription fee (first job, package not yet active) or
  set a zero budget (active window — the subscription already covers the job).
- `session.fund()` (no args) on the buyer side — the SDK reads the hook
  config off the on-chain job and dispatches through `SubscriptionHook`
  automatically; the buyer doesn't need any subscription-specific funding code.

## Lifecycle

```
buyer                                            seller
─────                                            ──────
createJobFromOffering(..., { packageId })
    │   ▶ job.created   ──────────────────────▶  case "job.created"
    │                                            (parses requirement message)
    │                                            isSubscriptionActive(...)?
    │                                            ├─ no  → setBudgetWithSubscription(
    │                                            │          offeringPrice + subPrice,
    │                                            │          subDuration, packageId)
    │                                            └─ yes → setBudgetWithSubscription(
    │                                                       0,
    │                                                       subDuration, packageId)
    │   ◀──────────  budget.set  ◀──────────
case "budget.set"
session.fund()   (auto-dispatches through SubscriptionHook)
    │   ──────────▶  job.funded   ───────────▶   case "job.funded"
    │                                            session.submit(...)
    │   ◀──────────  job.submitted ◀────────
case "job.submitted"
session.complete()
    │   ──────────▶  job.completed  ─────────▶   case "job.completed"
```

## Files

| File        | Role                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------- |
| `buyer.ts`  | Looks up the seller, picks a subscription-bearing offering, creates a job with `packageId`  |
| `seller.ts` | Resolves the package, charges offering + sub fee to activate, sets a zero budget while active |

## Run

These examples read the same `.env` as `basic/` (`BUYER_*`, `SELLER_*` plus
`SELLER_WALLET_ADDRESS` for the buyer-side lookup). See the
[examples README](../README.md#shared-setup) for env setup. The seller must
already have at least one offering with one or more `subscriptions` entries
registered on the [Service Registry](https://app.virtuals.io/acp/new) — the
buyer picks the first such offering and uses the first package on it.

```bash
# Terminal 1
npx tsx src/examples/subscription/seller.ts

# Terminal 2 (after seller logs "ready, listening for jobs")
npx tsx src/examples/subscription/buyer.ts
```

## Key API surface

```ts
// Buyer — pick a subscription-bearing offering and pass packageId.
const offering = agent.offerings.find(
  (o) => (o.subscriptions ?? []).length > 0
);
const subscription = offering!.subscriptions![0]!;

const jobId = await buyer.createJobFromOffering(
  base.id,
  offering!,
  agent.walletAddress,
  requirementData,
  { evaluatorAddress: buyerAddress, packageId: subscription.packageId }
);

// Seller — when entry.packageId is present, charge offering + subscription
// on the first job (activates the package) and zero on subsequent jobs while
// the package is still active.
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

  await session.setBudgetWithSubscription(
    AssetToken.usdc(totalPrice, session.chainId),
    BigInt(subscription.duration),
    BigInt(subscription.packageId)
  );
}
```

## Notes & gotchas

- **First-job budget is the sum.** The first job in a subscription pays
  `offeringPrice + subscriptionPrice` to activate the package. Set the
  buyer's budget cap (the example has a commented `MAX_USDC` reject in
  `case "budget.set"`) high enough to cover both, otherwise the buyer will
  reject its own first job and never activate the package.
- **Subsequent jobs in the active window are free.** Once the package is
  active, every follow-up job between the same buyer/seller pair is
  covered by the subscription — the seller sets a budget of `0` and
  `setBudgetWithSubscription` proposes terms that the contract recognizes
  as already-active and skips (emitting `SubscriptionTermsSkipped`). The
  buyer pays nothing more until the subscription expires.
- **Where the seller reads subscriptions from.** This example pulls
  `me.subscriptions` once at startup via `seller.getMe()` and keys them by
  `packageId`. `me.offerings[i].subscriptions` carries the same data scoped
  to a single offering — useful when the same package is re-used across
  multiple offerings and you want to validate the buyer picked a package
  that's actually attached to the offering they're requesting.
- **No fund-transfer hook here.** If the offering has `requiredFunds: true`,
  `createJobFromOffering` will create a `SubscriptionHook + FundTransferHook`
  multi-hook job and the seller would need
  `setBudgetWithSubscriptionAndFundRequest` instead. See
  [`subscription-fund-transfer/`](../subscription-fund-transfer/) for that
  variant.
