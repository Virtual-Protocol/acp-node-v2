# Off-escrow proportional-fee example

Demonstrates a **facilitator** job: the seller relays a value transfer that
settles **outside ACP escrow**, and ACP escrows **only a proportional fee**
(e.g. 8 bps of the transfer notional). The reference use case is Raxol's
`Xochi.TransferOffering` cross-chain stablecoin transfer — see Raxol issue
[#373](https://github.com/DROOdotFOO/raxol/issues/373).

Unlike [`fund-transfer/`](../fund-transfer/README.md) (where the buyer's capital
is custodied and forwarded through a hook), here the **principal never touches
the seller's wallet**. The buyer authorizes the transfer with their own signed
intent (ERC-3009 / Permit2); the SDK job carries only the fee.

> This example is **self-contained and stubbed**: it builds the offering object
> locally (the Virtuals registry does not yet allow *listing* a
> `percentage + requiredFunds:false` offering — relaxing that is the server-side
> change this motivates) and the Xochi quote/sign/settle calls are stubbed
> (`// TODO`). No cross-chain funds move. The ACP job lifecycle is real.

## Why this is a plain job

`priceType: "percentage"` with `requiredFunds: false` maps to the existing
**plain-job path** in `createJobFromOffering` (`hook = address(0)`). The seller
sets `budget = fee`; the buyer funds the fee; `submit`/`complete` split the fee
(90% provider / 5% platform / 5% evaluator). No contract change, no new hook.

## The three integrity checks

1. **Notional can't be faked.** The buyer declares the notional in the
   requirement (`feeBasisField` → `notionalAtomic`), but it is also **bound in
   their signed intent**. The seller calls `assertNotionalMatches(declared,
   boundInIntent)` and **rejects a mismatch before setting the budget**.
2. **Buyer sees the exact fee before paying.** On `budget.set` the buyer
   recomputes `computePercentageFee(notional, rate, unit)` and **only funds when
   it equals the seller's proposed budget** — otherwise it rejects.
3. **Disputes reduce to "does the settlement tx exist?"** The deliverable is a
   `settlement_tx_hash` on the destination chain
   (`buildSettlementDeliverable`); the evaluator verifies it
   (`parseSettlementDeliverable`). ACP only ever held the fee, so worst case is
   a fee refund, never lost principal.

## Lifecycle

```
buyer                                            seller
─────                                            ──────
buildTransferOffering()  (percentage, requiredFunds:false)
createJobFromOffering()  (plain job + signed-intent requirement)
    │   ▶ job.created   ──────────────────────▶  case "job.created"
    │                                            assertNotionalMatches(...)
    │                                            fee = rate * notional
    │                                            setBudget(fee)
    │   ◀──────────  budget.set  ◀──────────
case "budget.set"
recompute fee; fund() only if it matches
    │   ──────────▶  job.funded   ───────────▶   case "job.funded"
    │                                            relay intent to Xochi (STUB)
    │                                            submit(settlement_tx_hash)
    │   ◀──────────  job.submitted ◀────────
case "job.submitted"
parseSettlementDeliverable(...); complete()
case "job.completed" → transcript, stop
```

## Files

| File | Role |
| ---- | ---- |
| `buyer.ts` | Builds the local offering, `createJobFromOffering`, fee-preview check, funds the fee, verifies the settlement proof |
| `seller.ts` | Notional/intent check, `computePercentageFee`, `setBudget(fee)`, stubbed Xochi relay, `buildSettlementDeliverable` |
| `jobTypes.ts` | Transfer requirement type + parser, the local percentage offering, the shared `FEE_UNIT`, sample body |

## Run

Same `.env` as [`basic/`](../basic/README.md) (`BUYER_*`, `SELLER_*`). Start the
**seller first**, then the buyer:

```bash
npx tsx src/examples/off-escrow-percentage/seller.ts
npx tsx src/examples/off-escrow-percentage/buyer.ts
```

## Environment variables

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `OFF_ESCROW_FEE_RATE` | `8` | Fee rate in `FEE_UNIT`; buyer and seller must agree (the buyer's fee-preview check enforces it) |

## Security — what this stub does not do

The example demonstrates the ACP job *shape*, not a production-ready facilitator.
Three things must be real before this is safe to run with live funds:

1. **Signature verification.** `boundNotionalFromIntent` reads a plaintext field
   here, so `assertNotionalMatches` currently compares two buyer-supplied values
   and proves nothing. The whole "notional can't be faked" property depends on
   recovering the notional from the buyer's **verified** intent signature
   (Permit2 / ERC-3009), which lives outside this SDK (in raxol). Wire that up
   first.
2. **On-chain settlement check.** The evaluator here only checks the proof's
   shape and destination chain. A real evaluator must confirm
   `settlementTxHash` exists on the destination chain and moved the expected
   notional to the recipient. Completing without that is not evidence the
   transfer happened.
3. **Always use an evaluator.** This buyer self-evaluates (`evaluatorAddress`).
   Under skip-evaluation (`evaluatorAddress` omitted) a `submit` auto-completes
   and releases the fee with no settlement check — do not use skip-evaluation
   for this job type.

Also note the fee is computed in the **notional token's** units;
`computePercentageFee` does not convert tokens. The example works because the
notional token is USDC. If the notional token differs from the fee (budget)
token, USD-normalize before `setBudget`.

## OPEN QUESTION — confirm before merge

**Is `priceValue` for `priceType: "percentage"` in basis points or percent?**
Raxol's agent prices in **bps**; the Virtuals frontend may show **percent**.
`FEE_UNIT` in [`jobTypes.ts`](./jobTypes.ts) is the single switch, and
`computePercentageFee` takes the unit explicitly (it never guesses). Pin the
backend convention, then set `FEE_UNIT`.
