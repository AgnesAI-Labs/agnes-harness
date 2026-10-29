# File batches

English | [简体中文](README.zh-CN.md)

`@agnes/batch` owns file capture, durable item progress, validation and export. The installed
`batchPlugin` uses the current-profile managed runtime and the public Node SDK. Each item is an
ordinary visible conversation titled `batch <id> · <file>`, with its own workspace containing only
that item's copied input. Workspace sandbox and file policy enforce confinement. Unattended
sessions reject permission requests; the plugin never approves a workspace escape or a tool.
No batch authority or business engine is added to Core, Host or protocol.

Enable the package's `ext:agnes.batch` row, then configure its `batchWorker.configure` profile
service with `workspaceRoot`, `ownedArea` and the current profile's local `socketPath`. Paths must
be absolute and canonical. The private owned area must be disjoint from the source workspace;
use a dedicated directory under the installation/profile's owned data area. On Windows also
supply the verified local daemon `serverIdentity` (`pid`, `processStartId`). Configuration uses
native AR1 approval and contains no credentials. `batchWorker.status`, `.configuration`, `.retry`
and `.check` are the standard managed-service controls. No listener or extra daemon is started.

```sh
agh batch start inputs --prompt 'Summarize {{path}} ({{ordinal}})' --schema result.schema.json
agh batch start inputs --prompt-file template.txt --budget 5 --concurrency 4 --max-edge 1024 --out reports
agh batch status b123456abcdef --watch
agh batch results b123456abcdef --json
agh batch resume b123456abcdef
agh batch cancel b123456abcdef
agh batch export b123456abcdef --out final-copy
```

Start/resume/export use native profile effect admission; cancel is an urgent effect granting no
new execution. Approval-required/running receipts return exit code 3. After answering the approval,
repeat the exact start using its printed `--id` (and explicit `--operation` if supplied). Unknown
native effects are never resent. `--cwd` must match the configured source workspace.
`agh run --batch` remains a separate headless workflow.

Defaults: concurrency 4, timeout 600 seconds (60–3600), image edge 1456 (256–1456), one schema repair,
five consecutive failures before stopping, optional credit budget, and output `agh-batch/<id>`.
`--ext` accepts comma-separated extensions with optional leading dots and case/space normalization.
Templates support `{{name}}` (basename), `{{path}}` (the item-only copied path), and `{{ordinal}}`.
Image read instructions pass `max_edge` to the existing B3 `read` tool, which owns bounded decoding
and aspect-preserving resize. Capture leaves source originals unchanged; copied bytes are checked before dispatch.

The managed service uses the real transactional SDK owned store in its private SQLite database.
An operation fence is committed before any session creation/prompt side effect. The stable item
operation has bounded repair attempt records, and repairs reuse that item's session and deadline.
On reopen, any accepted operation lacking a durable terminal result becomes `unknown`; even an
outbox intent with no reply is never automatically dispatched again. Resume reconciles persisted
progress and continues safe pending work; it never resets or reruns unknown items. Unknown work
stops new admission and retains its reservation. Disabling/upgrading closes admission and cancels
active sessions. Process exit preserves progress. Output and billing transport failures remain
unknown instead of being treated as successful or free work.

Ordinary session costs are read through the public session usage projection. Each prompt carries its
reserved credit ceiling through the public SDK; Core durably binds that ceiling to the admitted turn
and reserves conservative request costs before provider dispatch. Missing price bounds or budget
storage refuse execution. Repairs share the remaining item allowance and original deadline. Unknown
work retains its reservation. A server without hard-turn budget support is refused before prompting.
Automatic title generation is suppressed for bounded turns. Existing profile and session policy still
applies. An omitted budget uses the largest safe numeric accounting bound. The bound assumes the
provider obeys its catalogued prices and output-token ceiling; inconsistent or missing billing remains
unknown and never frees a reservation.

Capture rejects symlinks, nonregular files, escapes and observed mutations. Hidden entries and the
reserved `agh-batch` directory are excluded. Unsupported types remain original `skipped` rows with
`unsupported_type`; text above 1 MiB or PNG/JPEG above 20 MiB remains `skipped` with `too_large`.
Limits: 100,000 files, 200,000 directory entries, 32 directory levels and 256 MiB captured bytes.
Snapshots use owned files, so large batches do not hold B3 pending receipts. The separately exported
`attachmentSnapshots` adapter remains available to callers explicitly supplying a real B3 scope.

Results are limited to 32 KiB each and 64 MiB per export. JSON Schema support is bounded to
object/properties/required/additionalProperties, array/items, scalar types, scalar enum/const,
numeric/string/array bounds and annotations. References, patterns, advanced combinators and
`uniqueItems: true` are refused with a clear error; schemas cannot fetch resources.

The output directory contains `results.jsonl`, `errors.jsonl`, `results.csv`, `summary.md`, a batch
ownership marker and `progress.json`. The driver exports settled rows incrementally, including
skipped rows; pending/running items are omitted from data files. Individual files are atomically
replaced and the digest marker is written last, so readers can detect an interrupted publication.
Reopen resumes publication only into the same batch's claimed directory. Existing unrelated output,
hidden paths and custom output overlapping the input tree are refused. Explicit `export` requires
terminal settled state and exclusively claims a fresh destination, writing `complete.json` last.
CSV cells are quoted and formula-prefixed; summaries do not interpolate model-authored content.
