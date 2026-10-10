# Intelligent UI contract

English | [简体中文](intelligent-ui.zh-CN.md)

[Architecture](architecture.md) · [Plugins](plugins.md) · [Frontend](frontend.md) · [Sessions and recovery](../guide/sessions.md) · [Web renderer](intelligent-ui-web.md)

This document defines the preset and reviewed custom-component surface contract. The official backend plugin, authenticated App Server methods and generic deferred execution bridge implement it; client rendering and the finance pilot are described below. Availability still requires the repository-wide validation pass.

## Ownership and scope

The official `agnes/intelligent-ui` plugin belongs in `packages/base/extensions/intelligent-ui`. It owns `ui_render`, `ui_update`, `ui_close`, extension facts and a replayable projection. Protocol owns declarations; Host and daemon adapters bind the authenticated session, actor, task/lane and pinned plugin generation. Core remains unchanged. Clients render backend facts and submit requests; neither an enabled button nor model prose grants permission.

Every surface appears as both a conversation card and a workbench panel. Expanding the card opens the panel for the same `(sessionId, surfaceId, revision)`. They share action receipts and drafts; expansion is presentation state, not a second surface or another execution. `placement.preferred` is a layout hint and cannot remove either placement.

Phase 1 supports forms, tables, data-only charts, button groups, plain text, status, detail cards, tabs, steps, progress and images. Date and date-time values are form field formats, not a separate component. There is no generated HTML, JavaScript, expression evaluator, remote component loader or arbitrary CSS. External UI dependencies stay in `packages/web-ui`; clients preserve its theme, accessibility, CSP and skin hooks. Labels supplied by business plugins are content; renderer controls and refusal messages have English and Simplified Chinese catalogs, keyboard access, live status announcements and stable test ids.

## Schema and bindings

The declaration source is [intelligent-ui.json](../../packages/protocol/schema/intelligent-ui.json); [generated types](../../packages/protocol/gen/ts/intelligent-ui.ts) are consumed from `@agnes/protocol/gen/intelligent-ui` or the root type exports. Run only the existing protocol generator when changing declarations; never hand-edit generated types. This schema is separate from `surface.json`, which describes deployed application artifacts.

`UiSurface` is a closed object with required `id`, `revision`, `title`, `placement`, `components[]`, `data{}` and `actions[]`. Surface ids are session-scoped, never reused after closing, and initially have revision 1. Component and action ids must each be unique in their respective lists. Data keys and component references resolve within this one surface. The backend validates these relationships as well as JSON Schema shapes.

| Component `kind` | Required fields besides `id`, `kind` | Behavior |
| --- | --- | --- |
| `form` | `dataKey`, `schema` | Initial value is `data[dataKey]`; draft is submitted under `input[component.id]`. Optional `actionIds` identify submit buttons. |
| `table` | `dataKey`, `rowKey`, `columns`, `selection` | Rows are objects. `rowKey` identifies a unique, nonempty string of at most 128 characters. Selection is `none`, `single` or `multiple`; optional `rowActionIds` refer to declared actions. |
| `chart` | `dataKey`, `chartType`, `categoryKey`, `series` | `bar`, `line` or `pie`; array of data objects, category strings and finite numeric series values. Pie has exactly one series and nonnegative values. No executable configuration. |
| `button-group` | `actionIds` | Buttons resolve to the surface's action list. |
| `text` | `dataKey` | A plain string, rendered as text. |
| `status` | `dataKey` | A plain string; processing/approval state comes from receipts, never this business label. |
| `detail-card` | `dataKey`, `fields` | One object in `data[dataKey]`. Each field reuses a column (`key`, `label`, optional `format`) and must be present. Optional `statusKey` and `secondaryKey` are nonempty strings of at most 256 and 1,024 characters. |
| `tabs` | `tabs` | Groups other components of the same surface. Each tab has `id`, `label` and `componentIds`. Every referenced component exists, each component is placed at most once, and a tab cannot contain another tabs component. |
| `steps` | `dataKey` | An ordered array of `{id, label, state, description?}`. `state` is `pending`, `active`, `done` or `error`. |
| `progress` | `dataKey` | `{label, value, total}`. `value` and `total` are finite numbers, `total` is greater than 0, and `value` is from 0 through `total`. A percentage is computed only for display. |
| `image` | `dataKey`, `alt` | `{source}` is an artifact `{kind:"artifact", sha256, size, mime}`, an `agnes-upload://` attachment, or a png/jpeg data URL. Remote URLs are refused. Alt text is required. |

All components may have `title`. Columns have `key`, `label` and optional `format` (`text`, `number`, `currency`, `date`, `status`); formats only affect display, never change values or infer currency units. Chart series have `key` and `label`. Bound data must exist and match the component shape. Invalid rows, missing fields, duplicate row ids and undeclared component kinds reject the whole render/update; they are not silently omitted.

Forms reuse the [existing schema renderer](../../packages/web-ui/src/plugin-schema-fields.tsx) and [model](../../packages/web-ui/src/plugin-schema-model.ts): `UiJsonSchema` is a boolean or JSON Schema object; local `$ref`, object/array/variant/enum/scalar controls and lossless JSON fallback keep their existing semantics. A string property with `format: "date"` or `"date-time"` is a date input. `date` is a real `YYYY-MM-DD`. `date-time` is that calendar date plus a time and `Z` or a numeric offset; leap seconds are only `23:59:60`. Empty or missing values remain incomplete drafts. The Web control shows `date-time` on the UTC clock and writes `YYYY-MM-DDTHH:mm:00Z`. The visual recursion threshold remains 6, independent of the backend payload limit. Unsupported assertions use the JSON fallback rather than a misleading partial form. Backend validation compiles the full schema and checks submitted values without coercion or dropping unknown properties. No network `$ref` resolution. Secret input is not a way to acquire authority: surfaces cannot carry raw credentials; any business credential field must use an existing credential-reference contract.

`UiAction` requires `id`, `label`, `tool`, `argsTemplate` and `paramsSchema`; optional `confirm` is a business confirmation prompt and `style` is `primary`, `secondary` or `danger`. The named tool must be declared and visible in the session's pinned composition. Neither labels nor templates can select another tool, workspace, session, actor, lane or permission. Action target changes require a new surface revision.

`argsTemplate` maps top-level tool argument names to exactly one of:

- `{ "literal": <JSON value> }` for fixed data;
- `{ "from": "data" | "input" | "row" | "selection", "key": "...", "pointer": "..." }` for a value binding. `pointer` defaults to the empty JSON Pointer.

`data` keys identify committed surface data; `input` keys identify form component ids; `row` keys identify the table component in the submitted row context; `selection` keys identify tables and resolve to arrays of backend-resolved row objects in displayed order. The client sends row ids, never authoritative row objects. The backend resolves rows from the accepted revision, validates membership, unique selected ids and selection mode, and rejects any row/selection source used outside the matching table action context. Table actions can use selection; row actions additionally use `row`. A form draft is checked against its form schema; expanded arguments must satisfy both `paramsSchema` and the registered tool's parameters. Missing keys/pointers and invalid pointer escapes are errors. Pointers use own properties only, disallow `__proto__`, `prototype` and `constructor` segments, and never run code or perform string interpolation.

### Bounds

The schema declares structural bounds and exports `X_AGNES_UI_LIMITS`; backend and renderer enforce the semantic/byte bounds as well. Bytes are UTF-8 encoded JSON before persistence.

| Item | Limit |
| --- | --- |
| One surface / one action request or expanded argument object | 32,768 / 16,384 bytes |
| One extension fact / total projection state and view | 65,536 / 262,144 bytes; preserve the existing tighter owner limits |
| Components / actions / data keys | 32 / 32 / 64 per surface |
| Id/data key / title/label / confirmation | 64 / 256 / 1,024 characters; tool name 128 |
| Columns / chart series | 32 / 8 |
| Table rows / chart points | 1,000 / 1,000 per component |
| Detail fields | 32 |
| Tabs / components in one tab | 8 / 16; nesting depth 1; each component placed at most once |
| Steps | 32 |
| Image alt | 1,024 characters |
| Image data URL | 16,384 bytes; `image/png` or `image/jpeg` only |
| Image artifact or attachment | 33,554,432 bytes; png or jpeg; no remote URL |
| JSON / schema nesting | 16 / 16; reject unbounded external references |
| Live surfaces / pending commands | 16 / 8 per session, at most one pending command per surface |
| Recovery page | 16 surfaces, 64 receipts; aggregate response is bounded to 262,144 bytes |
| Admission | 30 new command ids per authenticated actor/session in a rolling minute |

Aggregate projection capacity is enforced before writes, not merely each surface's limit. Rendering/updating over capacity refuses the operation, preserving the preceding revision. Read pages may contain fewer entries to fit the byte bound. Command identity and closed-surface tombstones remain ledger facts even when omitted from the bounded projection cache. Admission reconstructs its recent window from receipt facts after restart; concurrent admissions are serialized. Identical command retries do not consume a new-command quota. Overload returns the existing `OVERLOADED` RPC refusal with a retry hint; it does not create a business execution.

### Finance surface example

The following is a complete surface value. Amounts remain exact integer USD cents; display labels state the unit.

```json
{
  "id": "finance-review", "revision": 1, "title": "Reconciliation review (USD cents)",
  "placement": { "inline": true, "workbench": true, "preferred": "workbench" },
  "components": [
    { "id": "differences", "kind": "table", "dataKey": "differences", "rowKey": "id", "columns": [{ "key": "id", "label": "Transaction" }, { "key": "amountCents", "label": "Difference (USD cents)", "format": "number" }, { "key": "status", "label": "Status", "format": "status" }], "selection": "multiple" },
    { "id": "amounts", "kind": "chart", "dataKey": "differences", "chartType": "bar", "categoryKey": "id", "series": [{ "key": "amountCents", "label": "Difference (USD cents)" }] },
    { "id": "adjustment", "kind": "form", "dataKey": "draft", "schema": { "type": "object", "additionalProperties": false, "required": ["proposals"], "properties": { "proposals": { "type": "array", "maxItems": 1000, "items": { "type": "object", "additionalProperties": false, "required": ["id", "amountCents", "reason"], "properties": { "id": { "type": "string" }, "amountCents": { "type": "integer" }, "reason": { "type": "string" } } } } } }, "actionIds": ["confirm"] },
    { "id": "buttons", "kind": "button-group", "actionIds": ["confirm"] }
  ],
  "data": {
    "differences": [{ "id": "txn-1", "amountCents": 250, "status": "needs-review", "reason": "amount-mismatch" }],
    "draft": { "proposals": [{ "id": "txn-1", "amountCents": 250, "reason": "amount-mismatch" }] }
  },
  "actions": [
    { "id": "confirm", "label": "确认调整", "tool": "fde_finance_approve", "argsTemplate": { "proposals": { "from": "input", "key": "adjustment", "pointer": "/proposals" } }, "paramsSchema": { "type": "object", "required": ["proposals"], "additionalProperties": false, "properties": { "proposals": { "type": "array" } } }, "confirm": "Confirm these simulated adjustments? Nothing is posted.", "style": "primary" }
  ]
}
```

A row action implies selection of that row only. The backend resolves row ids against the displayed table. A business tool that consumes selected rows must declare their actual shape or explicitly project proposals; display-only fields are never stripped to bypass tool validation. The example binds the form's proposal array to the existing tool.

### Preset catalog example

Detail cards, steps, progress, images and tabs are data only. The percentage below is not part of the surface; the renderer and text fallback compute it. The image source is an authorized artifact identity, not a remote URL.

```json
{
  "id": "case", "revision": 1, "title": "Case review",
  "placement": { "inline": true, "workbench": true },
  "components": [
    { "id": "card", "kind": "detail-card", "title": "Record", "dataKey": "record", "fields": [{ "key": "name", "label": "Name" }, { "key": "amount", "label": "Amount", "format": "currency" }], "statusKey": "status", "secondaryKey": "note" },
    { "id": "flow", "kind": "steps", "dataKey": "steps" },
    { "id": "posted", "kind": "progress", "dataKey": "progress" },
    { "id": "scan", "kind": "image", "dataKey": "scan", "alt": "Receipt scan" },
    { "id": "when", "kind": "form", "dataKey": "when", "schema": { "type": "object", "properties": { "day": { "type": "string", "format": "date", "title": "Day" } } } },
    { "id": "note", "kind": "text", "dataKey": "note" },
    { "id": "sections", "kind": "tabs", "tabs": [{ "id": "main", "label": "Main", "componentIds": ["note"] }] }
  ],
  "data": {
    "record": { "name": "Ada", "amount": 250, "status": "open", "note": "Draft" },
    "steps": [{ "id": "review", "label": "Review", "state": "active", "description": "Check the draft" }],
    "progress": { "label": "Posted", "value": 1, "total": 4 },
    "scan": { "source": { "kind": "artifact", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "size": 128, "mime": "image/png" } },
    "when": { "day": "2026-10-10" },
    "note": "Inside the tab"
  },
  "actions": []
}
```

## Public operations and execution bridge

| Entry | Contract |
| --- | --- |
| `ui_render(UiRenderParams)` | Create revision 1; backend binds owner plugin/generation, task and lane. Re-entering the same normal tool invocation uses its existing receipt, not a second render. |
| `ui_update(UiUpdateParams)` | Full replacement, not JSON Patch. `surfaceId` must equal `surface.id`; expected revision must be current; next revision must be exactly current + 1. Owner/task cannot change. |
| `ui_close(UiCloseParams)` | Close at the expected revision, retaining the final surface and a tombstone. Revision is unchanged; closing the same revision again is a no-op. No reopening or id reuse. |
| `_agnes/v1/ui.action(UiActionParams)` | Authenticated submission; returns a durable `UiActionReceipt`, which may be `received` or pending rather than terminal. No caller-supplied tool or authorization. |
| `_agnes/v1/ui.read(UiReadParams)` | Authenticated recovery read; optional surface/command filter, opaque cursor and limit. Returns `UiReadResult` with a ledger high-water mark and bounded surface/receipt pages. |

These methods are registered App Server contracts; SDK sessions expose `uiAction()` and `uiRead()`. Session ownership checks happen before any read or write. Unauthenticated/wrong-session calls use existing authentication/capability RPC failures and expose no surface or previous command result. Malformed envelopes use `INVALID_PARAMS`; only a well-formed, session-bound command can enter the action state machine. Owner plugin is derived from the tool contribution, not model-supplied surface data. Surfaces are scoped to that ongoing session task; a new turn alone does not invalidate them. Backend task completion/retirement closes its surfaces through this contract.

Intelligent UI is the `intelligentUiKind` service (`@agnes/intelligent-ui-contract`): one provider per session, pinned to that session's generation. Tools obtain an instance with `providers.bindOwn`. Registration still requires the plugin's events grant and `surfaces` projection lease. Host supplies the owner ledger, exact `ui-result:` delivery, and the business dependencies (deferred queue, pinned component declarations, declared tool schemas). User actions and reads enter through the session port, which admits the authenticated actor and resolves SC1 delivery from the durable `action.received` fact. Daemon routes bind authenticated ownership before invoking that same session port. The service owns no dispatch or approval path. The projection retains full surface snapshots, active receipts and as many of the latest 64 terminal receipts as fit its byte limit; older commands remain recoverable by `ui.read({ commandId })` and ledger replay. A 64 KiB receipt reserve is kept inside the total projection budget.

Services do not expose an arbitrary tool dispatcher. The public [deferred tool invocation contract](deferred-invocations.md) is the single plugin-agnostic execution bridge, usable by UI, webhooks and schedules. Host binds its durable queue to the pinned session/lane and adds an optional port to the public Loop context without changing Core. The default Loop and the finance Loop drain it generically at safe step boundaries through `LoopContext.tools.execute`, `tools.resume` and `effects.status`; they contain no UI-specific helper or component logic. Intelligent UI is one producer: it validates the action, persists its binding, and enqueues the declared tool invocation. Queue facts and producer notifications remain ledger-backed. With no producing plugin installed the queue port is absent and default Loop scheduling is unchanged. A custom Loop lacking the generic drain capability refuses submission before tool dispatch. No direct `ToolDef.execute`, Core-private import, model-instruction execution bridge or consumption of unrelated SC1 inputs is permitted.

The immutable accepted command binds the surface revision, owner generation, task/lane, authenticated actor, action, fully validated arguments and a stable invocation id. Its command facts are the work queue, rebuilt from the ledger; no separate database or Agent input channel is added. At execution, the helper rechecks the bound task, surface and tool catalog, and then invokes the original named tool through ordinary tool policy, approval, auto review, sandbox and deny-list controls. Business `confirmed: true` satisfies only `action.confirm`; it grants no tool permission. Updating or closing a surface while any accepted action is `received`, `pending-approval` or `executing` returns `UI_BUSY`, preventing review data from changing under a ticket. An unresolved `outcomeUnknown` failure also keeps that surface locked until existing effect reconciliation resolves it. Different-command concurrent submits on the same surface also receive transient `OVERLOADED`, not a second invocation.

Receipt fields are state-dependent: `rejected` requires `refusal`, `failed` requires `failure`, `pending-approval` requires invocation/ticket links, and `succeeded` requires a durable tool-result link. Inapplicable failure/refusal fields are absent. These relationships are validated by the backend in addition to the structural receipt schema. `outcomeUnknown: true` always implies `retryable: false`.

A terminal result/refusal is delivered to the Agent only through the existing SC1 queued-input path: `next-step` when an active turn supports steering, otherwise `next-turn` with the existing idle wake. A durable result committed just as a turn ends must remain queued for the next turn. The queued content includes surface id/revision, action/command id, status, safe summary and ledger/tool-result references. Tool output remains untrusted evidence. The Agent may then call `ui_update` or `ui_close`; successful execution alone does not invent new business data or increment the surface revision. That queued input taints the continuation. A tool declares optional `isPresentational` when its effect only publishes display state to the user and has no external side effect. The default tool policy does not escalate that flag for the taint. `requiresApproval: always`, a destructive declaration, and the business tool that produced the result still ask. Official `ui_render`, `ui_update`, and `ui_close` declare the flag; `ui_submit` does not.

## Ledger facts and lifecycle state table

Plugin event names below use `x/agnes/intelligent-ui/` (abbreviated `ui/` in the table). Each surface fact contains the backend-bound owner/task/lane and a complete validated surface; `surface.closed` retains its final revision and reason. Each action fact contains command identity, actor, revision, previous fact reference and safe outcome links. Admission computes validation under the session serialization boundary. `action.received` persists the immutable original request and, for a valid binding, resolved arguments and invocation id before scheduling; an invalid binding records its refusal without inventing a tool invocation. Recovery completes an interrupted rejection from that original request before scheduling anything. Full tool output stays in the existing tool/effect facts, not a second unbounded copy. Extension facts explain UI state; ordinary Core authorization/effect facts remain authoritative for execution. Corrupt chains and missing referenced outcomes are recovery gaps, never successes.

| Entity / transition | Durable fact(s) | UI | Agent / idempotency |
| --- | --- | --- | --- |
| Absent → open | `ui/surface.opened` (revision 1), normal render tool receipt | Card and panel become visible | Normal `ui_render` result; an existing invocation receipt is reused. |
| Open n → updated n+1 | `ui/surface.updated` with full next surface and prior revision | Both placements replace committed data; dirty old drafts require review | Normal `ui_update` result; expected-revision compare-and-set. |
| Open n → closed | `ui/surface.closed` | Retain final view, disable inputs/actions | Normal `ui_close` result; repeat close has no new fact. |
| New command → received | `ui/action.received` | Show accepted/queued; freeze this surface's submissions | No business result yet; acknowledgment uses this command's receipt. |
| Received → rejected: invalid | `ui/action.rejected` (`UI_INVALID`) | Field/action errors; no execution | Queue safe typed refusal once. Includes input/args/schema failures. |
| Received → rejected: stale | `ui/action.rejected` (`UI_STALE`, current revision) | “Data changed, please re-confirm”; fetch current data, require another confirmation | Queue refusal once; revision mismatch never executes. |
| Received → rejected: closed | `ui/action.rejected` (`UI_CLOSED`) | Same re-confirm message; closed view remains read-only | Queue refusal once; closed is a stale-action class with a specific reason. |
| Duplicate transport submit → first command's state | No new execution/fact for an identical request; return the original command's latest durable receipt with `duplicate: true` | Reattach to first outcome, including pending state | No extra queued input. This is a duplicate disposition, not a new rejected business action. |
| Same commandId, changed request → rejected: duplicate | Existing first receipt remains unchanged; existing command journal records conflict, no new action chain | `UI_COMMAND_CONFLICT`; do not overwrite first outcome | No execution/input; caller must read the first command. |
| Received → rejected: unauthorized | `ui/action.rejected` (`UI_UNAUTHORIZED`); existing policy refusal when applicable | Explain unavailable tool/denied action | Queue refusal once; no business effect. |
| Received → pending-approval | Existing `tool/call`, `approval/asked`; `ui/action.pending-approval` links invocation and ticket | Existing approval UI plus waiting state in both placements | No success input; confirmation is distinct from permission. |
| Pending-approval → rejected: unauthorized | Existing `approval/decided` and tool refusal; `ui/action.rejected` | Denied/cancelled approval | Queue refusal once; resuming original invocation returns original refusal. |
| Received or pending-approval → executing | `ui/action.executing`; existing authorized tool/effect intent | Processing; action locked | No terminal input yet. Plugin fact alone never proves authorization or dispatch. |
| Executing → succeeded | Existing `tool/result`, `effect/settled`; `ui/action.succeeded` links durable receipt | Success and safe summary; unlock surface | Queue result once, then Agent continues and updates surface. |
| Executing → failed | Existing tool/effect error or recovery evidence; `ui/action.failed` with `retryable` and `outcomeUnknown` | Error; retry only when permitted; unknown outcome requires reconciliation | Queue failure once; no optimistic business-data update. |
| Failed → retried → received (new command) | `ui/action.retried` links `retryOf` and new command; new `ui/action.received` | Previous failed attempt remains; new attempt shows queued | Fresh validation/authorization; old command always retains its failed outcome. |
| Terminal → delivery pending → delivered | Existing SC1 enqueue/claim facts; `ui/action.delivered` links the queued item | Terminal result remains visible independently of Agent progress | Stable delivery key derived from session + command id; replay repairs delivery without duplicating input. |

`retried` is an edge between two attempts, not an in-place reset or an extra `UiActionStatus`. `pending-approval` is reached only if the ordinary tool path requests it. Approval and execution refusals are distinguished from business tool errors. Failure/cancellation before dispatch is retryable when its effect evidence proves no execution; a tool error after dispatch is not automatically safe to retry.

### Idempotency and ordering

The durable key is `(sessionId, commandId)`, including rejected submissions, and is checked after authentication but before stale/closed validation, quota or tool dispatch. Compare the canonical complete request (excluding transport request id); identical requests return the first attempt's current receipt even if the surface subsequently changed or closed. A different request under the same key is a duplicate conflict and cannot mutate the first result. `UI_COMMAND_CONFLICT` is a typed `SEMANTIC_REJECTED` RPC refusal, not a rewritten first action receipt. `UiActionReceipt.seq` points at its latest action fact; `duplicate` is response metadata, not persisted business state. Clients retain command ids during reconnect and generate a fresh id only for a new user decision or explicit safe retry.

Serialize render/update/close, submission admission and execution-state transitions against the session ledger's existing single-writer ordering. A received command has no authority until full validation and normal tool authorization pass. Failures between receipt and scheduling are recoverable from `action.received`. Stable invocation identity is bound to the accepted arguments; approval resumes that same invocation. Never create a second tool call to consume an existing ticket. Do not promise exactly-once external effects: uncertain receipts follow existing effect recovery and remain non-retryable until reconciled.

Different command ids can still repeat a business intent. The same surface has one in-flight action; after terminal success the Agent must update/close it to reflect processed rows, and the business tool must reject already-processed transactions. Transport idempotency does not replace business validation.

## Recovery and degradation

| Situation | Required recovery |
| --- | --- |
| Browser refresh / reconnect | Read surface/receipt pages at a consistent ledger watermark, then attach existing session events after that sequence; detect gaps and reread. Both placements use one projection. No execution from mounting a card. |
| Unsaved drafts | Optional session-scoped local browser draft, keyed by surface/component/revision, shared between card and panel. It is not backend processing state. Discard or explicitly rebase it on revision change; never silently submit an old draft. Reload restores committed backend data even if drafts were never saved. |
| Approval pending across reload | Recover the original invocation/ticket using existing approval records, not just a UI status; show the existing approval control. No auto approval or new ticket. |
| Daemon restart before dispatch | Replay surface/action facts; reconstruct pending work; validate the immutable binding and execute once via the normal Loop helper. |
| Restart mid-execution | Consult existing invocation/effect state. Known success/failure fills any missing terminal UI fact without rerunning the tool. Pending approval resumes its original call. Missing/uncertain effect receipt becomes `failed` with `outcomeUnknown: true`, `retryable: false` and an evidence link; existing reconciliation must resolve it before a new attempt. |
| Crash between result and Agent enqueue | Scan terminal facts lacking delivery; enqueue using the same SC1 dedupe key. If enqueue succeeded before the delivery marker, recover the existing item and append the missing marker. No second result input. |
| Tool failure + retry | Preserve old failure. Require a new command id and `retryOf`, current revision/confirmation, proven retry eligibility and fresh normal authorization; chain both attempts. |
| Missing pinned plugin/Loop or corrupt projection | Follow existing fail-closed generation/recovery behavior. Rebuild a valid projection from ledger if possible; otherwise show unavailable/evidence-gap state and disable actions. |
| TUI / channel without preset rendering | Plain-text title, revision, status, rows/amount summary, detail fields, steps, progress, image alt and source identity, tab labels, action labels and an authenticated link to the existing Web session's surface panel. Progress percentages are display-only. Image text never includes a data URL or a remote fetch. Never create a public bearer link or call tools because a text label was displayed. Text “confirm” alone is not a UI submission or approval. |

Pagination cursors bind a snapshot watermark and filters. Live events during the snapshot are buffered and applied after it; reconnect uses the standard session attach/catch-up mechanism. Cursor expiry causes a fresh read. Projection rebuilds do not append new business facts. Durable commands are never forgotten merely because a display page or cache evicted them.

## Trace, pilot and later migration

Fact-chain and trace views must show surface id/revisions and ownership, received command/actor, resolved tool invocation, approval, effect and result, terminal UI fact, queued Agent input and the Agent's next surface update. Link by ledger sequence and stable ids, not nearby event timing. Missing receipt/delivery/revision links are visible gaps. The UI never elevates plugin-authored labels or facts into evidence of a permission decision.

The [finance reconciliation pilot](../../examples/fde/finance-reconcile/index.mjs) keeps synthetic source ledgers and exact integer cents. After reconciliation it renders a detail card and review steps beside the differences table, a bar chart and an adjustment form. “确认调整” maps to the existing `fde_finance_approve` simulated adjustment tool, whose approval-required metadata and policy remain intact. The business tool validates proposals against the committed reconciliation facts and selection, including transaction membership, integer cents, reason, no duplicate ids and whether they were already processed. Form edits cannot override committed differences unnoticed. After permission and a simulated receipt, the queued result resumes the Agent; it updates processed rows to `simulated-approved`, retains unresolved transactions and states `posted: false`. Approval denial/failure never marks rows processed. The generic deferred-invocation drain replaces the pilot's existing business-question stage; it does not require a second free-text “Proceed”.

### Reviewed custom components

A business plugin can declare namespaced kinds (`<plugin-id>/<name>@<major>`) in `contributes.client.intelligentComponents`, or in the `client` object of its ordinary-plugin `agnes.client.json` descriptor. The namespace is the extension id for an extension manifest, and the package name for an ordinary-plugin descriptor. A positive major version is part of the kind; changing an incompatible props contract requires a new major.

```json
{
  "client": {
    "id": "reconciliation-diff",
    "entry": "./reconciliation-diff.mjs",
    "intelligentComponents": [{
      "kind": "@agnes-fde/finance-reconcile/reconciliation-diff@1",
      "propsSchema": { "type": "object", "required": ["rows"], "properties": { "rows": { "type": "array", "maxItems": 1000 } }, "additionalProperties": false },
      "maxPropsBytes": 16384,
      "fallback": "Review the preset differences table.",
      "accessibility": { "label": "Reconciliation differences", "keyboard": true }
    }]
  }
}
```

The module exports `renderers`, an object keyed by the exact declared kinds. Each function receives `(mount, props, api)` and may return a cleanup function or a promise of one. Types `IntelligentUiRenderer` and `IntelligentUiRendererApi` are exported by `@agnes/web-client`. The API has only `emitAction(id)`, `readTheme()` (`light`/`dark`), and `readLocale()` (`en`/`zh-CN`). An emitted id must be in that component's `actionIds` and the surface's `actions`; the host calls the existing surface confirmation, tool and approval path. It supplies no input, row, tool name, session accessor or service client.

Custom modules use the existing install review, capability digest, trust, immutable assets and session-generation roster. They are self-contained ESM entries (at most 262,144 bytes), with no runtime imports, slots, services or external styles. They execute in an opaque-origin iframe with `sandbox="allow-scripts"` and a separate CSP that denies fetch/network resources, forms and nested frames. The host does not import them into its own document. Renderers own only their frame mount; render text with `textContent`, provide semantic labels and keyboard-operable controls, preserve focus visibility, and dispose resources on teardown. The manifest's keyboard requirement is an author/reviewer obligation, not automatic accessibility certification.

The model emits a data-only component: `id`, namespaced `kind`, `dataKey`, `fallback` and `actionIds` (plus optional `title`). `surface.data[dataKey]` holds props. Backend `validIntelligentSurface(surface, declarations)` resolves the declaration from the durable session generation, validates its local synchronous JSON Schema before persistence, checks the exact declared fallback, and refuses unknown or ambiguous kinds. No current-installation substitution is allowed. Bounds: at most 16 declarations per module; schema 16,384 bytes and depth 16; props at most the declared limit (1–16,384 bytes); fallback 1–4,096 characters; the existing surface byte/depth/component limits still apply. Schemas cannot load remote references or run asynchronous validation.

The browser checks the server-validated surface projection, pinned module identity, exact fallback and declared props byte limit. Full props schema compilation remains in the backend; the workbench CSP does not permit dynamic function compilation.

When a ready, reviewed pinned module cannot be found, its import/render fails, or loading exceeds 15 seconds, the component displays its declared text fallback and a localized notice. Other preset/custom components continue working. TUI and channels receive the fallback in `ui_render`/`ui_update` tool text. The [finance example](../../examples/fde/finance-reconcile/client/agnes.client.json) uses a small reconciliation diff renderer and keeps its preset differences table alongside it as the usable fallback.

The preset question/table migration and authenticated text-client submission are described in “Question, table and deliverable surfaces” below. Custom renderers use the same surface facts and action flow; text clients display their declared fallback. Business answers remain distinct from permission grants.

Phase 2 uses the same surface/action model for official questions, tables and deliverable lists. The old inline slot formats and answer-prefix parser have been removed. There are no compatibility shims or old-data migration. See the interaction paths below.

## Implementation acceptance

Extend the nearest meaningful suites to cover every state-table transition, canonical command duplication/conflicts, invalid schemas/bindings, changed revision, closed surfaces, owner/task and missing tool/unsupported Loop refusals, policy/approval/auto-review denial, sandbox failures, capacity/rate admission, concurrent commands, tool errors and safe/unsafe retry, receipt/delivery crash gaps and restart with pending approval/unknown effect. Include a scripted-model finance workflow and a Web spec for shared inline/panel state, reload and re-confirmation. Real daemon/worker tests belong in `*.e2e.test.ts`; large-ledger/real-timer tests belong in `*.slow.test.ts`. Test observable receipts, facts, tool outcomes and queued inputs, not private call counts. Backend and renderer implementation must be reviewed before claiming this capability is available.

The finance Loop version 4 / codec 4 drains the same generic contract and consumes SC1 at a completed step boundary. It validates proposals against its committed reconciliation checkpoint and records processed transaction ids there before reporting queue completion. The original invocation may recover its cached result; another command cannot simulate the same rows again. The opaque invocation id is a SHA-256 binding of surfaceId, revision and commandId, within the existing 128-character tool id bound. Surface schema shape is unchanged. Fact-chain adds bounded `plugin-fact` metadata nodes for revisions, deferred state, action outcomes and SC1 delivery, linked by recorded sequence/id references; trace adds bounded metadata spans outside Core. Form data and arguments are omitted from these labels.

The public Host author testkit exposes `AuthorSession.uiAction()` and `uiRead()` for this pilot. `AuthorTestOptions.packageDirs`, `presets` and `preset` explicitly supply isolated official manifests and the business policy preset; they never load the developer home or credentials.

The backend and renderer share `@agnes/protocol/intelligent-ui` surface validation, including table columns and chart display semantics. Default reads return open views; `surfaceId` reads retain closed ledger evidence. Closed views do not consume projection capacity or permit ID reuse.

Read cursors are authenticated, expire after 60 seconds and bind the watermark, filters and page size. Later pages replay that watermark and omit the first page’s bounded receipts. Backend result follow-ups survive cancel as next-turn inputs; delivery acknowledges durable enqueue, while queue claim consumes the input.

Backend result inbox items carry `origin: system` and `trust: untrusted`, independently of the human actor that submitted an action.

## Question, table and deliverable surfaces

`ask_user_question` keeps its model-facing parameters. Official interaction producers invoke `ui_render` through ordinary tools. Questions use a preset form and the declared `ui_submit` collector; tables use the table preset; deliverables use plain text plus existing artifact references. The collector verifies the Host-recorded deferred invocation against the immutable authenticated action. Direct model calls are refused. Successful collection closes the surface and delivers the full accepted answers through SC1, preserving the authenticated actor and untrusted content. Answering confers no tool permission. The durable timeout controls only the optional wait; it does not close the form or expire late answers. Deferred execution proceeds at the next safe Loop boundary.

Text clients recover surfaces through `ui.read`. The TUI shows numbered choices and submits form drafts through `ui.action`, retaining the displayed revision and command identity on transport retry. Complex forms/actions use the authenticated Web link. Channels show the same surface data and numbered choices; their existing callback protocol cannot authenticate a surface action, so submission uses the Web link. Configure the channel runner's `outbound.webUrl` with the reachable HTTP(S) Web base URL (no credentials/query/fragment). The link contains only session/surface identifiers and still requires normal Web authentication and ownership. It carries no token or permission grant.

The session envelope reserves the eleven documented `surface.*` and `action.*` events under `x/agnes/intelligent-ui/`. Other dotted extension event names remain refused. Official surface-producing tools declare `tools.invoke` and call `ui_render` through the ordinary authorization path.
