# Session runtime contract

The session execution owner is an immutable `RuntimeIdentity` with `id` and
`version`. Built-in identities are `native@1` and `jevloop@1`. A historical
`session/start` or session-list row without `runtime` denotes `native@1`; an
unknown explicit identity must never be replaced by Native during creation or
recovery. Factory generation is process-local and is not the durable version.

`session/new` accepts a runtime ID in `_meta["ai.agnes.harness"].runtime`.
Omission preserves Native creation for existing clients. Runtime selection must
be validated by the backend and persisted before execution. This does not alter
the vendored ACP schema. There is no runtime-switch operation: continuing a
session retains its owner, and unsupported compact/fork operations must refuse.

`_agnes/v1/runtime.list` takes `{}` and returns `{ items: RuntimeDescriptor[] }`.
Each descriptor contains its ID, version, label, `apiVersion: 1`, availability,
an optional safe unavailability reason, and explicit prompt/cancel/resume/compact/
fork capabilities. Availability is a discovery hint, not authorization or a
reservation; the backend must check again when creating or recovering a session.

`_agnes/v1/session.runtime` takes `{ sessionId }` and returns the persisted
runtime identity and the current lifecycle phase. Its optional `revision` is a
monotonic runtime-state revision for that session, not a ledger cursor or worker
generation. Reading state must not create, reopen, recover, or execute a session.
An absent session returns the existing session-not-found error. The endpoint
provides a runtime-neutral view without forcing JevLoop into Native OpState.

SDK consumers use `client.runtime.list()`, `client.session.new({ cwd, runtime })`
and `session.runtime()`. For an explicit selection, the SDK first requires a
supporting catalog entry. An old daemon lacking the catalog, an unknown ID, or an
unavailable runtime rejects before creation; no default-loop retry occurs. Calls
that omit runtime retain the existing creation RPC without a discovery roundtrip.

Schemas own the wire types; run the protocol generator after editing them.
Consumers must negotiate new operations instead of inferring support from a
model, preset, browser setting, or an existing session's missing metadata.

## Explicit runtime control

`_agnes/v1/session.runtimeControl` accepts `{ sessionId, expectedRuntime, operation, payload }`.
It uses the session's existing owner authorization and an already-open writer. It
does not create, reopen, resume, enqueue or run a session. An identity mismatch,
Native runtime, unknown operation, running/maintaining runtime or closed/hibernated
session refuses. Core routes the generic operation; only its runtime adapter
interprets the payload. SDK callers use `session.controlRuntime(...)`.

JevLoop supports `jev.resolveUnknown` with exactly `intentId`, `resolution`,
`explanation` and `evidence`. The resolution is `confirmed_applied`,
`confirmed_not_applied` or `accepted_uncertainty`; explanation and each evidence
string must be non-empty after trimming, and evidence must contain at least one
item. The intent must currently be unresolved. The adapter records the authenticated
actor and appends `action.resolved` to the original intent's turn through the same
durable writer. It never repeats the action or advances queued work.

Success returns `{ runtime, result: { intentId, resolution }, effectiveFromSeq }`,
where `effectiveFromSeq` is the committed resolution's ledger cursor. Concurrent
controls and execution refuse until that commit finishes; close waits for it.
An append or acknowledgement failure is not success. Its durable outcome may be
unknown: explicitly reopen and inspect the committed prefix before deciding whether
another resolution is needed. A committed resolution survives reopening; neither
reopening nor successful control automatically executes a queued followup.

## Comparison coordination

The `comparison.create/get/reconcile/submit/cancel` Agnes methods operate on two independent
sessions. Creation accepts a stable `requestId`, a source workspace, two runtime
choices and optional shared preset/model settings. Snapshot isolation is the
default; `worktree` is reserved and must explicitly refuse until implemented.
The backend completes the snapshot before creating either session and stores the
baseline ID, digest and policy hash. Wire results expose workspace labels.

Submission uses a stable `inputId` and content blocks. A `ComparisonRound` records
one acceptance for each side; the backend validates side uniqueness. `accepted`
has a sequence, `rejected` has a definitive error, and `unknown` has no sequence
and may have an error. Transport uncertainty must never be converted into a
definitive rejection or retried with a new input identity. The operation does not
claim atomic acceptance. Settlement is tracked independently of acceptance.

`comparison.get` is read-only and never performs reconciliation.
`comparison.reconcile` is an explicit command that checks durable session receipt
and terminal evidence to reconcile the comparison record. It must not open,
resume, enqueue or execute a session; unknown evidence stays unknown.
Clients call it only on an explicit operator action, never on automatic refresh. Cancelling one side leaves the other side's
session and approvals intact; omitting side requests cancellation of both.

## Comparison journal and accounting

`_agnes/v1/comparison.journal` and `client.comparison.journal(params)` take
`{ id, afterSeq?, throughSeq?, limit?, maxBytes? }`. Cursors are nonnegative safe
integers; `limit` is 1–1000 and `maxBytes` is 2–4194304. The result is
`{ id, entries, afterSeq, throughSeq, nextAfterSeq, complete }`. `afterSeq` is
exclusive and `throughSeq` is inclusive. Retain the returned `throughSeq` across
pages and advance with `nextAfterSeq`; later publications do not move that prefix.
A byte limit too small for the next complete entry must refuse rather than split
or silently skip it.

Each entry is `{ seq, cuts: { left, right }, fact }`: `seq` orders comparison
publication, while cuts are cumulative committed lane-ledger cursors. Facts form
a closed union. Coordinator facts retain revision, creation, lane session/runtime
bindings and phases, round count, latest-round run/acceptance/terminal evidence,
accepted sequences, cancellation and cleanup. Lane facts identify side, session,
local sequence and digest. Checkpoints explicitly mark baseline/recovery/legacy
coverage; they do not claim reconstructed cross-lane ordering. Facts exclude
prompts, source paths and workspace snapshots.

`_agnes/v1/comparison.metrics` and `client.comparison.metrics({ id, atSeq })`
read exactly one published comparison prefix and return `{ id, atSeq, cuts,
lanes }`. Each lane carries its side, session, immutable runtime binding and
accounting. The backend owns the comparison baseline (`accounting.afterSeq`);
clients cannot supply an accounting start cursor. `accounting.throughSeq` is
that lane's selected cut. Both operations are read-only: they never reconcile,
open, resume, enqueue or execute sessions.

The comparison history reads below also work without a loaded session or an existing
workspace. Each request supplies `{ id, side, atSeq }`; the server authenticates the
comparison and resolves its recorded lane and journal cut. Clients cannot override
`sessionId` or `throughSeq`. Every response includes those resolved coordinates.

- `_agnes/v1/comparison.events` / `client.comparison.events` additionally take
  `{ afterSeq, limit?, maxBytes? }`. They return `events`, `afterSeq`,
  `nextAfterSeq`, and `complete`. The cursor is exclusive; completion means the
  returned cursor reaches the selected lane cut. Limits are 1–1000 events and
  1–2097152 bytes; the server may use a smaller page to leave transport framing
  space. Binary data is omitted using the same markers as `diagnostics.events`,
  and transport `_meta` is excluded. Missing or out-of-order rows are refused.
- `_agnes/v1/comparison.projectUI` / `client.comparison.projectUI` additionally
  require `{ surface: 'web' }` and return `timeline: CoreUITimeline`. This is the
  existing Core ledger projection without a writer `generation`, live provider
  settings, or executable extension hooks. It does not open a runtime to fill
  missing live metadata. Oversized or incomplete projections fail explicitly.
- `_agnes/v1/comparison.readToolDetail` / `client.comparison.readToolDetail`
  additionally take `{ callSeq, resultSeq?, offset?, maxBytes? }`. Success is
  `{ ok: true, page }`, with the existing bounded tool-detail page fields;
  failure is `{ ok: false, reason }`. The default offset is 0 and the default
  maximum page size is 262144 bytes. Both event sequences must belong to the cut.
  `client.comparison.toolDetail(input, { signal?, expectedSource? })` assembles and validates these
  pages into `{ call, result? }`, pinning the comparison, side, journal position,
  session, and lane cut throughout. Pass `expectedSource: { sessionId, throughSeq }`
  from the displayed projection to validate the first page as well; it is a local
  response check, never a server authorization parameter. It shares the session detail decoder and its
  64 MiB total limit.

History responses reserve framing space under the transport's 2 MiB ceiling.
`HISTORY_INVALID_ARGUMENT`, `HISTORY_INCOMPLETE`, `HISTORY_LIMIT`, and
`HISTORY_UNAVAILABLE` are bounded refusal codes; failures do not expose storage
paths. Reading history does not itself archive data or authorize releasing a
workspace. Artifact references retain their existing authorization and retention
rules; a readable tool result does not promise retained attachment bytes.

Accounting separates Jev and LLM attempt families, disjoint `inputUncached`,
`cacheRead`, `cacheWrite`, `output` token buckets and reasoning tokens. Totals
carry `state`, `value`, `knownSubtotal` and `missing`; incomplete evidence remains
`partial`/`unknown` with nullable values, never an invented zero. Costs are a
dynamic currency-to-total map projected only from captured historical usage and
pricing. Missing pricing increments `unpricedAttempts`; an empty costs map is
not a known zero charge. Optional `inputTotal` and `total` counters retain attested
codec semantics without inventing a missing cache split. Optional `outcomes` and
`byPurpose` count observed provider-calls, including pending and unknown outcomes;
they do not claim to observe hidden wire retries. Optional `reportedBilling`
separates persisted `gateway` and `estimated` USD-micro amounts, with subscription
counts and missing-attempt coverage. These reported amounts never replace token
quote costs; credits are not converted into money. Absent legacy fields are unknown.
Issues preserve evidence limitations. Schema
validation checks shapes and bounds; backend readers enforce cursor ordering,
publication membership, lane uniqueness, identity and baseline relationships.


### Historical quote details

`comparison.priceDetails({ id, side, atSeq, afterSeq?, limit?, maxBytes? })` reads
sanitized per-provider-call evidence at the same fixed journal cut as metrics.
It never opens a session, calls a provider, or reads current prices. `afterSeq`
(default 0) pages request **origin** sequences, not the accounting boundary. The
default page size is 25, maximum 100. `maxBytes` bounds the JSON entries array
(default 256 KiB, maximum 1 MiB); a first entry that cannot fit is refused with
`PRICE_DETAIL_LIMIT`, rather than skipped. Keep `id`, `side` and `atSeq` fixed for
all pages. Responses bind `sessionId`, runtime and lane `throughSeq` and return
`nextAfterSeq`; exhausted pages advance to the fixed lane cut.

`complete` means all observed detail entries have been paged. `evidenceComplete`
and `issues` independently report whether the whole source prefix was available
and verified. Exhausting an incomplete source does not prove complete accounting.
The reader shares metrics' bounded contiguous scan; a missing page or scan limit
retains partial/unknown totals. Each entry includes canonical attempt identity,
origin/settlement coordinates, purpose, requested/observed model, outcome, token
bucket totals, the validated frozen quote, applicable multiplier, bucket estimates,
and separately reported billing. Request, output and reasoning **text** are never
included. Reasoning tokens are a subset of output, not another charged bucket.
A pending request never imports its future settlement into an earlier cut.

A missing quote remains null. A retained quote can still be unusable because its
route/model does not match, the observed model differs, or the recorded interval
crosses validity/calendar bands. Missing usage/rates preserve unknown buckets and
known subtotals. All quote amounts are estimates, not invoices; currencies are
not converted or added to one another. Legacy calls and Jev decision calls without
quotes stay unknown. The Web panel loads details only when expanded and rejects
stale cursor/identity/page responses. Prepared configuration currently remains
unknown: current profile/model settings cannot stand in for a frozen receipt.

### Frozen model-price estimates

`ModelRecord.pricePolicy` configures an independent ISO currency, per-million disjoint
input/cache/output rates, optional HTTPS verification source/date, inclusive
`validFrom` and exclusive `validUntil`, and a fixed UTC-offset off-peak calendar.
The calendar includes peak weekdays/windows and excluded local dates. At provider-call
admission, Native `x/core/model-call` and Jev language `call.input.pricing` persist
an exact route/requested-model `ModelPriceQuote`, including its admission timestamp
and detached policy. Settlements preserve that snapshot; replay never consults
current catalog prices. An explicit policy wins even when expired or partially
priced. Without one, positive catalog rates can supply a frozen USD estimate;
an all-zero catalog with no explicit free-price policy remains unknown.

Historical `costs` are estimates, not official invoices. A request-to-settlement
interval must remain inside one validity/rate band, including internal calendar
transitions; crossing a peak or expiry leaves the multiplier unknown. A different
observed model cannot reuse the requested-model price. Unknown token/rate buckets
retain known subtotals; an attested zero bucket needs no invented rate. Reasoning
is an output subset and is not billed twice. Persisted gateway billing and catalog
estimated billing remain separate from quote estimates and from credits. Old calls
without quotes retain unknown historical prices. Jev decision pricing and its
unattested cache split remain unknown until an exact backend price policy and usage
contract are available.

`comparison.submit` can return `SEMANTIC_REJECTED` with data
`{ code: 'COMPARISON_BUSY' | 'COMPARISON_NOT_READY', id, inputId,
phase: 'pre-admission', inputAccepted: false }`. This bound marker means that
particular input was explicitly rejected before reservation/accounting admission.
CAS, storage or transport errors without this marker do not prove non-admission;
retain the original `inputId` when checking its receipt.

### Saved comparisons

`comparison.list({ cursor?, limit? })` reads only the authenticated principal's
saved summaries, including failed or incomplete creation. The default page size
is 25 and the maximum is 100. New records sort by durable insertion order, newest
first; coordinator updates do not move them. Continuation cursors bind the
principal and the first page's upper insertion bound, so later creations do not
shift a continuation. Item status is the current committed status, not a frozen
multi-page state snapshot. No list operation opens, resumes or reconciles a lane.

Summaries expose identity, phase, revision, round count, runtime identities and
whether a complete comparison view is available. They exclude prompt payloads,
credentials and workspace paths. New insertions persist `createdAt`/`updatedAt`
in the same transaction as the coordinator record and journal; failed CAS cannot
advance them. Legacy records receive a stable listing position during storage
initialization, but missing historical times remain null. List reads never create
missing journal facts or synthesize historical creation times. Release and removal
require a separate owner-quiescence and durable admission-fence contract.

### Frozen comparison preparation

New comparison snapshots and coordinator journal facts optionally carry
`prepared.left/right` (`ComparisonPreparedReceipt`). Each receipt binds the exact
session/runtime to a trusted ignorable `x/host/session-prepared` source sequence
and canonical SHA-256 event digest. Host captures actual final model slot settings,
registered tool definitions and effective fitted permissions under the session
lock, after model selection has been applied. Publication stores the receipt and
coordinator fact in the same comparison CAS transaction; the separate session
append precedes publication. A lost reply or incomplete preparation never permits
reconstructing a receipt from a request or current profile.

`comparison.metrics` returns optional nullable `lanes[].prepared` at the fixed
`atSeq`: both a coordinator publication in that journal prefix and its exact trusted
source event covered by the lane cut are required. Before the source cut, absent or
conflicting evidence, and old comparisons without receipts remain unknown.
Archive-backed reads apply the same source validation and never reopen a session.
No arbitrary client configuration is accepted. Runtime configuration contains only
safe decision coordinates (no URL credentials/query/hash) and frozen scalar Jev
limits, including the actual preset step-limit override. Native has no runtime-specific
configuration. Environment values, transport objects, API keys, raw profiles and
physical paths are excluded.

Preset fingerprints explicitly cover the resolved Core preset view, not mounted
plugin-generation configuration; registered-tool fingerprints cover complete public
definitions, not the model-specific capability-filtered offered subset. New receipts
also carry optional `effective.mounted` and `fingerprints.mounted`: a digest of actual
active Host row configurations and the selected preset row, privately bound to the
same published Core runtime object. Declared mount identities and actual validated
fiber configurations participate; inactive/unavailable rows and non-JSON or oversized
configuration leave this evidence null. An in-place configuration change invalidates
the bound evidence. Only digest/count/scope are exposed, never raw plugin configuration.
This scope excludes other unselected preset definitions and browser-only rows; it is
not an attestation of arbitrary plugin internal state. Legacy omission remains unknown
and revalidation does not enrich its immutable historical source.
Permission fingerprints cover actual approval
settings, YOLO, fitted enforcement and the full effective file/network policy;
only the independent workspace root is normalized on path segment boundaries.
The exact fitted policy digest remains separate. Missing fitted permission evidence
is null. New preparation is immutable and later configuration drift refuses a new
receipt; historical receipts are never overwritten or backfilled.

The current daemon captures these receipts during comparison creation. Calling the
Host preparation method again verifies actual state against its immutable source,
but comparison continuation does not yet perform a joint two-lane configuration
preflight before reserving an input. That common pre-admission check remains required
for complete DSH resume configuration equivalence; a stored digest alone does not
hold configuration fixed across input reservation and execution.

For `comparison.release`, complete comparisons retain the existing `ComparisonSnapshot` result.
A failed preparation whose reserved sessions have verified durable acquisition evidence returns
`ComparisonPreparationReleasedResult`: `{id, revision, storageState: "released", kind: "failed-preparation"}`.
This receipt confirms resource release and preserves the original preparation failure; it does not
invent prepared lanes, configuration or a replay baseline. Missing acquisition evidence remains
unknown and refuses cleanup. `comparison.remove` can subsequently remove this released record.
