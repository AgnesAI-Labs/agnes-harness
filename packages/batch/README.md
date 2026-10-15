# Batch business service

English | [简体中文](README.zh-CN.md)

This package owns file manifests, item attempts, credit reservations, output validation and exports.
It is under integration: a runtime adapter must supply an owner-bound store, immutable artifacts and
Host-enforced confined child/job execution. The package is not installed as a runnable plugin yet.
The test executor is synthetic and must never be registered as production authority.

`createBatchPlugin(connector)` registers the declared `batch.*` query/effect services through the
public plugin API. The connector resolves Host-admitted context to a bound `BatchService`; request
data cannot select its owner or workspace. The default `batchPlugin` entry refuses installation
with `E_BATCH_MANAGED_CONNECTOR_REQUIRED` until that runtime integration is supplied.

`startManagedBatch(runtime, ports)` consumes the real `ManagedServiceInit`, `ManagedServiceRuntime`
and transactional `OwnedStore` contracts. The supervisor supplies one profile-bound instance; batch
creates no separate singleton or listener. The driver serializes ticks, discovers manifests before
mutating versioned store cursors, and registers shutdown before readiness. Disable/upgrade closes
admission and cancels active work; a missed shutdown deadline returns unknown with reservations
intact. Process exit preserves durable work for reconciliation. Native confined dispatch, workspace
and scoped artifact bindings remain required injected ports.

`BatchService` binds one workspace and owner outside request data. A persisted intent is written before dispatch; lookup and dispatch
use the same key after an interrupted response. Missing evidence remains unknown and retains its
credit reservation. Resume reconciles evidence; it does not reset an unknown item or replay effects.
Cancellation fences the dispatch key, including a key that has never been accepted, and waits for a
terminal billing receipt before publishing terminal state. These guarantees are mandatory adapter
contracts, not properties a Loop or tool filter can establish.

Input capture rejects symlinks, nonregular files, path escapes and observed file/directory changes.
It stores immutable byte snapshots, not paths that a later child can reopen. Limits are 100,000 files,
20 MiB per file, 256 MiB per capture by default, 200,000 enumerated entries and 32 directory levels.
Hidden entries and unsupported extensions are excluded. Aborted captures may leave unreferenced
artifacts; the artifact store owns their collection. Filesystem adapters remain responsible for
hostile concurrent directory replacement and platform-specific guarantees.

`attachmentSnapshots` consumes the public `AttachmentStore` and `AttachmentScope` contracts. It
checks the returned artifact hash, size, MIME and exact scoped receipt, and discards receipts from
an unsuccessful capture. Input records retain their artifact reference and receipt scope; terminal
execution receipts must match the prepared session and lane. Scope binding must come from Host.
Only Core's committed child inbox input permits confirmation; a saved batch manifest does not.
The runtime adapter must account for attachment pending-root quotas/expiry and owner-store quotas
before accepting a large or long-lived batch. This package does not relax provider limits.

Every concurrent attempt reserves a hard credit ceiling from the remaining batch budget. Repairs
reserve a new ceiling, retain the same child/input and share the original item deadline. Cancelled
attempts are charged using backend receipts. Unknown work stops further admission. Output is at most
32 KiB of JSON data per item; at most two repairs are allowed. Consecutive invalid/failed items stop
admission at the configured threshold.

Output schemas use a bounded subset: object/properties/required/additionalProperties, array/items,
scalar types, numeric bounds, string/array length bounds, scalar enum/const, title/description and
`$schema`. Other keywords, including regex, references, async validation, uniqueItems and combinators,
are refused. Validation has fixed depth/node/work ceilings. Schemas cannot load external resources.

Exports contain `results.jsonl`, `errors.jsonl`, `results.csv` and `summary.md`. CSV cells are quoted
and spreadsheet formulas are prefixed; terminal control/formatting characters are removed from CSV
and human summaries. Model content stays in data files and is never interpolated into the summary.
An exclusive directory claim refuses existing targets and racing exporters. `complete.json` is written
last; an interrupted directory without that file is incomplete and cannot be silently overwritten.
The default total export ceiling is 64 MiB. Exports do not execute or trust model-authored content.

The CLI command module is a transport client: it validates options, reads bounded prompt/schema files,
and delegates enumeration, execution and export to the bound backend. `agh run --batch` remains a
separate supported headless workflow.
