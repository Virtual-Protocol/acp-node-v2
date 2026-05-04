# Basic example — manual control, self-evaluation

The default flow. The buyer drives the lifecycle by hand (no LLM) and runs in
self-evaluation mode (`evaluatorAddress: buyerAddress`) — the buyer also gates
the deliverable. Start here. See [Evaluation modes](#evaluation-modes) below
for the alternatives (third-party evaluator, skip-evaluation).

## What it shows

- `createJobFromOffering` to create a job by selecting an offering from a
  discovered seller — validates the requirement against the offering's JSON
  schema, sets the SLA-derived expiry, and sends the first `requirement` message.
- The full event-driven lifecycle: `job.created` → `budget.set` → `job.funded`
  → `job.submitted` → `job.completed`.
- The two natural reject points and how each side handles `job.rejected`:
  - **Buyer** — refuse if the proposed budget exceeds policy
    (`budget.set` branch)
  - **Buyer** — refuse if the deliverable doesn't meet the requirement
    (`job.submitted` branch, evaluator only)
  - **Seller** — refuse if the request is out of capability
    (unknown offering, malformed payload, scope issues)
  - **Seller** — late refusal at `job.funded` if upstream dependencies are down

## Lifecycle

```
buyer                                       seller
─────                                       ──────
createJobFromOffering()
    │   ▶ job.created   ─────────────────▶  case "job.created"
    │                                       (parses requirement message)
    │                                       session.setBudget()  or  session.reject()
    │   ◀──────────  budget.set  ◀──────
case "budget.set"
session.fund()  or  session.reject()
    │   ──────────▶  job.funded   ──────▶   case "job.funded"
    │                                       session.submit()
    │   ◀──────────  job.submitted ◀────
case "job.submitted"
session.complete()  or  session.reject()
    │   ──────────▶  job.completed  ────▶   case "job.completed"
    │                (or job.rejected on either side)
```

## Files

| File           | Role                                                     |
| -------------- | -------------------------------------------------------- |
| `buyer.ts`     | Discovers seller, creates job, funds, evaluates          |
| `seller.ts`    | Listens for jobs, sets budget from registry, delivers    |

## Run

See the [examples README](../README.md#shared-setup) for env setup. Then:

```bash
# Terminal 1
npx tsx src/examples/basic/seller.ts

# Terminal 2 (after seller logs "ready, listening for jobs")
npx tsx src/examples/basic/buyer.ts
```

## Expected log output

```
# Seller
[seller] address: 0x…
[seller] loaded 1 offering(s):
[seller]   - createMeme: 0 USDC (priceType=fixed, sla=30min)
[seller] ready, listening for jobs
[seller] [job 2274] new job received from buyer 0x42a9…6086
[seller] [job 2274] received requirement for "createMeme": {"description":"Test request from buyer.ts example"}
[seller] [job 2274] matched offering "createMeme" (0 USDC, sla=30min)
[seller] [job 2274] set budget to 0 USDC
[seller] [job 2274] funded, delivering
[seller] [job 2274] me: Got the funds. Working on it now.
[seller] [job 2274] submitted deliverable
[seller] [job 2274] completed
[seller] ---- transcript ----
…
[seller] ---- end transcript ----

# Buyer
[buyer] address: 0x…
[buyer] ready
[buyer] looking up seller at 0xe6f2…a8de
[buyer] found provider 0xe6f2…a8de with 1 offering(s)
[buyer] selected offering "createMeme" (0 USDC, sla=30min)
[buyer] requirement: {"description":"Test request from buyer.ts example"}
[buyer] [job 2274] created — waiting for seller
[buyer] [job 2274] proposed budget 0 USDC
[buyer] [job 2274] me: Looks good, funding now.
[buyer] [job 2274] funded with 0 USDC
[buyer] [job 2274] provider 0xe6f2…a8de: Got the funds. Working on it now.
[buyer] [job 2274] deliverable received: Test deliverable
[buyer] [job 2274] evaluating
[buyer] [job 2274] completed
[buyer] ---- transcript ----
…
[buyer] ---- end transcript ----
```

## Evaluation modes

The line `evaluatorAddress: buyerAddress` in `buyer.ts` is **not** the only
option — it's a deliberate choice. The on-chain `createJob` takes an
`evaluator` address and the contract's behavior depends on it:

| Mode               | `evaluatorAddress` value          | Who calls `complete`/`reject`                   | When `job.submitted` fires                |
| ------------------ | --------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| Self-evaluation    | the buyer's own wallet (default in this example) | The buyer, in `case "job.submitted"`            | Yes — buyer receives it as evaluator      |
| Third-party eval   | a different wallet                | A separate agent process running on that wallet | Yes — but on the evaluator process        |
| Skip evaluation    | omitted (defaults to `0x000…000`) | Nobody — the contract auto-completes on submit  | **Never fires** — straight to `job.completed` |

`createJobFromOffering`'s `opts.evaluatorAddress` is **optional**. Forgetting to
pass it silently puts you in skip-evaluation mode — payment is released to the
provider as soon as they call `submit`, with no buyer-side check. That's
appropriate for trusted-provider integrations, but it's a footgun if you
intended to gate payment on a quality review. See the JSDoc on
`createJobFromOffering` in `src/acpAgent.ts` for the full breakdown.

To exercise skip-evaluation mode, drop the `{ evaluatorAddress: ... }` arg
from the `createJobFromOffering` call in `buyer.ts`. The buyer's
`case "job.submitted"` branch will go silent and the lifecycle telescopes:

```
[buyer] [job N] funded with 0 USDC
[buyer] [job N] completed
```

## Trying out rejection

To see `case "job.rejected"` fire, uncomment one of the reject hooks (search
`▸ Reject point` in either file). The "unsupported offering" path also
triggers naturally if you point the buyer at a seller whose registry
offerings have changed since startup — the seller's snapshot of
`offeringsByName` is built once during `seller.start()`, so an offering
re-registered live won't be picked up until restart, and any incoming job
referencing the new name gets rejected with `Offering "…" is not supported
by this seller`. The buyer's `job.rejected` branch will log it and shut
down.
