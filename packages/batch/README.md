# Batch business service

This package owns file manifests, item attempts, credit reservations, output validation and exports.
It is under integration: a runtime adapter must supply an owner-bound store, immutable artifacts and
Host-enforced confined child/job execution. The package is not installed as a runnable plugin yet.
The test executor is synthetic and must never be registered as production authority.

`BatchService` binds one workspace and owner outside request data. The runtime drives `tick()` after
startup and while work is active. A persisted intent is written before dispatch; lookup and dispatch
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
