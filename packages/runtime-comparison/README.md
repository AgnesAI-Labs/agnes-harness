# Runtime comparison domain

Pure coordination and accounting for two independent Agnes sessions. This package
uses the public `Comparison*` wire types and injected ports; it imports no Host,
filesystem, provider, worker framework or plugin container. The implementation is
new Agnes coordination and accounting code. The calendar selector in `src/pricing.ts`
is adapted from DSH under MIT; see `UPSTREAM.json` and `DEEPSEEK-LICENSE.txt`.

`ComparisonCoordinator` accepts `ComparisonPorts` from `src/ports.ts`:

- `store.read/compareAndSwap`: durable, atomic full-record CAS. Each caller receives
  detached snapshots. `requestId` is the comparison ID inside the caller's
  authorized namespace; filesystem adapters must hash/encode it, never concatenate
  it into a path. A rejected CAS has made no write; a thrown write is uncertain.
- `workspaces.prepare/release`: freeze one authorized source before materializing
  two independent roots. The adapter owns realpath/symlink handling, include/exclude
  policy, byte/count limits and cleanup on partial preparation failure. It must
  produce a genuine digest and policy hash, and must never fall back to shared cwd.
- `sessions.create/enqueue/run/cancel/close/inspect`: two reserved session owners
  with independent approvals, budgets and authority. Creation reservations are
  addressable by comparison ID and side even when the creation reply is lost.
  Resolve shared preset/model configuration consistently for the comparison, not
  independently against mutable defaults. `enqueue` only admits content and records
  a durable receipt; it must not start execution. `run` is one attempt. `cancel`
  fences the input ID before aborting, including a late racing `run` invocation.
  `inspect` reads exact input receipts and settlement facts without reopening work.

Creation persists a request reservation, freezes the baseline, waits for both
session preparations and then exposes the two lanes. Failure first persists a permanent
retirement fence for the reserved session identities, then waits for both close
attempts; only two confirmed exits permit workspace release. Failed cleanup remains in the
record for explicit Host repair. A process crash during preparation is never
automatically retried: ownership must first be reconciled by the Host. Successful
workspaces remain owned by the comparison for later rounds; cancellation does not
delete them. Explicit deletion/retention policy is a Host responsibility. The production
daemon checks the root-session admission fence before opening or mutating either lane;
historical reads and cancellation retain their authority. Production retirement verifies and fences the complete owned trees, then archives history before
removing execution storage. Released comparisons remain inspectable through fixed-cut readers;
explicit history removal is a separate operation.

The production daemon separates workspace authorization from ordinary navigation.
Comparison-owned roots and lane sessions remain bound to their execution authority,
but are omitted from ordinary workspace/session lists. Saved comparison APIs retain
their history and inspection surface. This is an ownership-based backend projection,
not a client-side directory-name filter or deletion of execution resources.

Submission persists the canonical input identity before any side effect. Each side
gets an accepted/rejected/unknown receipt; all receipts commit before independent
background runs start. The method returns after admission, without waiting for the
runs to settle. A failed lane does not cancel its peer. Duplicate input IDs return
the existing record; different payloads reject. Unknown transport effects are never
resent, including after restart. `get` only reads; explicit `reconcile` inspects
receipts and updates coordinator facts without running or submitting anything.
Waiting, parked and recovering remain unsettled. `drain` waits for this instance's
already-dispatched work and reports background persistence errors.

Before two valid lanes and a baseline exist, current wire fields cannot represent
a partial creation. `create/get` return `COMPARISON_IN_PROGRESS` or
`COMPARISON_CREATE_FAILED` instead of fabricating required fields. The Host ledger adapter projects exact committed comparison cuts into the public
metrics contract; absent historical evidence remains unknown.

`accountLane` and `readLaneAccounting` use a frozen `(afterSeq, throughSeq]` window.
The Host reader must pass the upper bound through every ledger page and report any
scan gaps. Every event retains a real attempt identity and origin sequence, including
failed requests; inherited attempts are excluded. Jev/LLM are distinct families.
Tokens use disjoint input-uncached/cache-read/cache-write/output buckets; reasoning
is an output subset, not a fifth billable bucket. Missing usage/rates/multipliers,
conflicting evidence, contradictory totals and overflow preserve uncertainty.
Currencies remain separate. `knownSubtotal` is never a claimed complete total.

Run focused tests from the repository root:

```sh
pnpm exec vitest run packages/runtime-comparison/tests --maxWorkers=1
```

Accounting evidence may carry purpose, requested route/model, observed model and
completed/failed/cancelled/unknown settlement outcomes. An observed start without
a settlement is pending; legacy settlements without outcomes are unknown. These
identities describe provider-calls, not otherwise invisible HTTP retries. Malformed
or conflicting attribution, outcomes or billing invalidate the attempt's evidence.
Family outcomes and `byPurpose` retain observed counts without per-attempt response
arrays. Optional wire additions keep legacy responses readable.

`inputTotal` and `total` preserve independently attested usage counters; missing
cache splits stay unknown. Normalization belongs to each codec adapter, including
safe arithmetic over attested disjoint counters. `reportedBilling` retains persisted
USD micros separately for gateway and estimated sources, subscription/non-subscription
request counts, and missing-attempt coverage. No missing billing becomes zero;
subscription metadata is not an inferred discount. Token-price `costs` stays separate; no ledger backfill or credit-to-currency conversion
occurs. The Host may explicitly supply exact-route Jev current estimates for missing legacy
quotes, identified by `priceBasis` and aggregated `currentPriceAttempts`. Total-input pricing
requires equal input rates and never invents cache splits. Billing-source totals are partial/unknown whenever billing coverage is missing.


Frozen token-price estimates use `ModelPricePolicy`/`ModelPriceQuote` from Protocol.
The admission snapshot binds an exact route/model, independently denominated rates,
verification source, validity and off-peak calendar. `pricingFromModelQuote` uses
only that snapshot and durable settlement time: internal rate transitions, expiry
and an observed-model mismatch remain unknown. It never reads current prices.
Explicit configured policies, including free/partial/expired policies, prohibit
catalog fallback. Catalog quotes are frozen USD estimates and all-zero catalogs
without explicit free-price provenance remain unknown. Estimates are not invoices;
reported gateway/estimated billing and credits remain independent. Partial positive
buckets retain known cost subtotals; attested zero usage needs no invented rate.

Preparation adapters may return a `prepared` receipt alongside their lane. The
coordinator stores it separately from the public lane, publishes it with the ready
CAS and refuses known unequal common fingerprints before execution. Legacy ports
may omit it; omission is unknown rather than evidence of equal configuration.
Production Host captures the actual final state after selection and persists an
anchored source event. Fixed-cut metrics require both coordinator publication and
a matching source row. The preset fingerprint attests resolved Core knobs; optional
mounted evidence separately attests actual active Host row configurations and the
selected preset, bound to the published runtime view. Known unequal mounted hashes
also refuse creation. Missing/null evidence remains unknown and historical receipts
are never upgraded from current profiles. Runtime-specific Jev settings are frozen separately and do
not participate in the common configuration equality check.
The production joint admission adapter revalidates both prepared configurations and tree owners
before continuation; it refuses changed or unverifiable preparation without replaying accepted input.

`permissionMode` is selected once per round (`workspace` defaults to manual approval, `view`
auto-rejects Web approval requests, `full` automatically approves within the same isolation).
It is not a filesystem permission switch: comparison sessions never enable YOLO. The Host
validates the complete immutable creation baseline under the writer lock, temporarily selects
the shared approval policy within each admission owner, and returns source-backed round receipts.
The winning reservation stores that mode and both receipts; both owners must pass the final
barrier before execution. Release restores the original policy. A lost owner after restart remains
fenced and requires cancellation, not automatic execution. Round mode/receipts are immutable;
an explicit different mode with the same input ID conflicts, while an omitted-mode retry retains
the original round. Subsequent omitted-mode submissions inherit the last selected mode.

An optional clock port records running start time in the reservation CAS. Only a settled run
promise confirms monotonic elapsed milliseconds. Recovery never fabricates missing timing.
Journal coordinator facts carry optional per-side timings and terminal sequence fences; result
projections require captured lane evidence before presenting completion or cumulative timing.

Optional `bucketCosts`, `priceMultipliers` and lane `totalCosts` expose DSH-style
comparison rows without client-side pricing. Bucket amounts share the family quote
and fixed prefix; total-input and disjoint input buckets are alternative bases.
Currency totals combine the two families while retaining missing evidence; neither
reasoning tokens nor reported gateway billing is added a second time. Older wire
responses omit these fields and remain unknown. Preparation receipts now record
`model.maxTokens` as the preset override (null means no override). Historical receipts
without this field retain their original source and fingerprint, while the full
preset digest still refuses a changed output cap.
