# App Server v1

English | [简体中文](app-server.zh-CN.md)

[Documentation](../README.md) · [API contracts](api.md)

One daemon owns the App Server for an `AGH_HOME`. CLI, TUI, Web, channels, ACP, SDK and stdio clients use its authenticated method contract. Workers execute tasks; a stdio bridge only forwards frames to that daemon.

`_agnes/v1/session.revealWorkspace` is a client-tier local desktop action: input `{ sessionId }`, result `{ opened: true }` after the native opener starts. It requires an authenticated local Unix/loopback-Web connection and session ownership, revalidates the session’s authoritative workspace binding, and accepts no client path. Remote/headless runtimes and missing/stale workspaces are rejected. It launches `open`, `explorer.exe`, or `xdg-open` with a detached argv call and no shell. Optional `initialize._meta.agnes.platform` (SDK `InitializeInfo.platform`) identifies the daemon OS for client labels.

## Sessions, turns, events and approvals

A session has durable identity, history, workspace authority and pinned plugin code. A turn starts with `session/prompt`; previews arrive as `session/update`. Attach with `_agnes/v1/session.attach` to receive durable `_agnes/v1/session.event` records. Persist the ledger cursor for reconnects; previews are ephemeral. The prompt response reports its stop reason.

The optional `session/prompt._meta["ai.agnes.harness"].creditLimit` is a finite, nonnegative total credit ceiling for that turn (at most `Number.MAX_SAFE_INTEGER / 1_000_000`). The SDK exposes it as `session.prompt(input, { creditLimit })` and first requires `initialize.agentCapabilities._meta["ai.agnes.harness"].hardTurnBudget: true`; an older server cannot silently downgrade it. Core persists the ceiling with inbox admission and turn acceptance, reserves conservative model request costs in the existing durable budget store, and keeps uncertain holds through recovery. Missing storage or catalogue price bounds stop execution. Budget escalation, automatic titles, unreserved policy-model reviews and child delegation are unavailable on these bounded turns. Prices and output-token limits remain provider contracts; incomplete or inconsistent billing must be reconciled before releasing a caller's reservation.

A client offering `clientCapabilities._meta["ai.agnes.harness"].capabilities.permission: true` receives `session/request_permission` server requests. Reply using the original request id and one of the offered option ids. Declining, disconnecting or timing out fails closed. A client must apply its own user confirmation policy; an example that declines all requests is safe for learning.

Workspace admission uses `_agnes/v1/workspace.add`; a caller's `cwd` alone grants no authority. The same session and plugin generation are visible from every transport.

`_agnes/v1/profile.decisions.list` lists the authenticated local human's pending profile operations; `_agnes/v1/profile.decisions.answer` submits a revision-checked answer. After an authorized list call, that connection receives `_agnes/v1/daemon.notice` with `kind: "decisions_changed"` for its server-bound profile and resolved principal (`detail: { profile, principal: { id, org } }`). Creation, answers, expiry and withdrawal invalidate the list after their durable commit. Notices contain no decision IDs, prompts, subjects, answers or counts and grant no data access. Re-read the authorized list on a notice, focus/visibility return and reconnect; notices are best-effort and have no replay cursor. This is an additive v1 notice kind.

## Authentication and management

Local IPC authenticates the OS owner on the daemon's private Unix socket or verified Windows pipe. `agh app-server --stdio` supplies the local credential at initialization; it never puts credentials on stdout. Treat the child process as a trusted local administrator. EOF and signals close its connection, leaving the shared daemon running.

Browser WebSocket traffic retains loopback, Origin, bearer and session authorization checks. Local BFF HTTP paths retain exact-origin and fixed-scope checks and use a private Node SDK connection. Browsers receive no local daemon credential. Source-auth, portal and channel clients retain their existing server-established grants; client labels are not permissions.

Daemon-owned settings use `_agnes/v1/admin.*`: `bundles.get`, `bundles.save`, `composition.get`, `search.get`, `search.save`, `search.test`, `context`, `history.search`, `plan`, and `mcp.oauth.save`. These methods require a local administrator grant. Writes require activation permission; context and plan only inspect registered, available workspaces. Bundle saves report `restart-required`. Existing package/resource/config methods remain in the same contract.

HTTP paths remain compatibility adapters: `/admin/plugins/api/*`, `/admin/resources/api/*`, `/api/context`, `/api/history-search`, `/api/plan-mode`, and client-module service/effect routes. Native workspace pickers and browser OAuth redirects remain client transport capabilities; the daemon owns their resulting workspace admission and credential operations.

## Errors

An error has a JSON-RPC number, a fixed safe message, and `data`:

```json
{"code":-32011,"message":"SEMANTIC_REJECTED","data":{"code":"SEMANTIC_REJECTED","reason":"CONFIG_CREDENTIAL_REJECTED","messageKey":"appServer.errors.credentialRejected","diagnosticId":"00000000-0000-0000-0000-000000000001","cause":{"code":"CONFIG_CREDENTIAL_REJECTED"}}}
```

Existing numeric codes stay unchanged: JSON-RPC uses `-32700` and `-32600` through `-32603`; AGH uses `-32001` through `-32013`. `data.code` retains the stable business code. Existing structured fields such as `reason`, validation issues and generation metadata remain compatible. `data.cause` carries only schema-allowlisted codes, including credential, provider and generation failures; nested messages, stacks and data are discarded. Unexpected exceptions use a fixed internal message and no private exception text. A diagnostic id correlates failures; `diagnosticUnavailable` means the audit sink could not record that failure. An envelope id does not promise an audit receipt.

Known public rejection codes are defined by `AppServerErrorCause` in `packages/protocol/schema/app-server.json`. Its annotations generate the shared RPC category, public reason and user action in English and Simplified Chinese. The envelope adds `data.publicReason` and `data.userAction` (fixed English copy) beside `diagnosticId`; `data.cause.code` retains a specific refusal even when an RPC category groups several codes. The SDK keeps these fields unchanged. Clients can use `publicErrorHelp(error, locale)` from `@agnes/protocol`; Web uses `appServerErrorMessage` from `@agnes/web-ui`. Unknown domain errors remain generic internal failures, and unknown reason identifiers are never translated from exception text. Business decisions such as `business.confirm` retain their answered option (including `reject`) in the decision snapshot; a rejected business answer is not a transport failure.

Render `data.messageKey` using local translations, never exception prose. HTTP status remains transport metadata; HTTP errors use the same numeric envelope under `error`. HTTP clients that previously read `error.code` as a string should read `error.data.code`. Web provides English and Chinese mappings through `@agnes/web-ui`.

## Export and versioning

```sh
agh app-server schema --out ./app-server-contract
agh app-server --stdio --home /absolute/isolated-home --profile local-dev --cwd /absolute/project
```

Schema export does not start a daemon. It writes `app-server-v1.json` and a standalone `app-server.ts` with no package imports. The schema's `x-version` is 1; `x-methods` records method direction, kind and params/result references. It is a catalog: validate the referenced params/result definition for the selected method. `packages/protocol` owns schemas and the method table; generated files are checked by `pnpm gen:check`. SDK `client.request(method, params)` uses generated method-specific types. Existing `client.call` and convenience APIs remain supported.

The ACP initialization version remains 1, and AGH extensions retain `_agnes/v1`. Within v1, clients should tolerate additive methods and error data fields. Incompatible shapes require a new version; do not infer compatibility from the CLI release number.

## JSONL example

Write one JSON object per UTF-8 line; ids, notifications and server requests pass through unchanged. Do not log on stdout. Frames are bounded by the SDK decoder; pending bridge input and output are each bounded at 32 MiB. A malformed frame closes the bridge with a parse error. EOF disconnects immediately rather than awaiting all prompt responses; cancellation/recovery continues under the daemon's session lifecycle.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}}
{"jsonrpc":"2.0","id":2,"method":"_agnes/v1/workspace.add","params":{"path":"/absolute/project"}}
{"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":"/absolute/project","mcpServers":[]}}
```

Wait for each result before using its returned identity. Then send `session/prompt` with that session id and a text prompt. The [stdio example](../../examples/app-server/stdio.mjs) performs this sequence, prints events on stderr, declines approvals, and closes stdin after the turn. `agh acp` and `--mode acp` use the same local bridge; embedded/ephemeral ACP is refused. ACP `--connect` retains its SDK transport for authenticated remote daemon connections.

## Runtime diagnostics

`_agnes/v1/doctor.run({probeAccounts?: boolean})` is a generated, local-owner-only method. Browser HTTP uses `POST /admin/api/doctor` through the exact-origin BFF; callers cannot select a home or profile. It returns `DoctorResult`: aggregate `status`, ordered `checks` with `id`, `status`, `fixHintKey` and optional non-sensitive counts/disk bytes/`probed`, plus an optional opaque `homeId` for browser preference scoping. Default checks never contact model services; `probeAccounts: true` explicitly tests enabled accounts. Cancellation propagates to model probes. Fix keys are rendered by the client locale catalog. No credential values, account labels, URLs or exception bodies are returned. See [first run](../guide/getting-started.md).

## Session workspace files

`_agnes/v1/session.workspace.list` accepts `{ sessionId, path? }` and returns `{ path, truncated, entries }` (at most 500 entries, optional git badges). `_agnes/v1/session.workspace.read` accepts `{ sessionId, path }` and returns `{ path, size, binary, truncated, text? }`. Both require session ownership and workspace-relative paths, refuse symlinks and the installation home, and confine canonical paths to the admitted workspace. Text previews are capped at 1 MiB; binary or oversized files omit text. These are read-only session methods, available through `Session.workspaceList`/`workspaceRead`, not administrative APIs.

`_agnes/v1/session.workspace.changes` accepts `{ sessionId, scope?: 'session' | 'turn', path?, expectedRevision? }`. It returns bounded confirmed write/edit effects, added/removed line counts, current freshness, coverage flags and an optional selected read-only diff with actual ledger coordinates. It requires the same session ownership and current workspace authority as list/read. Historical receipts never authorize a path or include later external changes in the agent's diff. The SDK exposes `Session.workspaceChanges`; see [workbench review limits and provenance](../extend/workbench-panels.md#changed-files-review).

`_agnes/v1/session.undo.preview` accepts `{ sessionId, turn? }` and is read-only: for the latest file-changing turn (or `turn`) it lists each file with what undo would do (`restore`, `delete` a file the turn created, or `unchanged`), whether it is undoable and why not (`legacy-receipt`, `no-checkpoint`, `checkpoint-collected`, `changed-since`, `missing`, `unreadable`), plus `busy`, `blockedBy`, later turns that must be undone first and whether the turn also ran shell commands (whose changes are never restored). `_agnes/v1/session.undo` accepts `{ sessionId, turn, commandId }`, is idempotent on `commandId` and is limited to the session's owner principal. It refuses with `SESSION_BUSY` while a turn runs, `UNDO_READ_ONLY` for a read-only session, and `UNDO_CONFLICT` (listing the files) when any file no longer holds the bytes the turn last wrote; there is no force and no partial restore. Each file returns to its content before the turn's first write, in path order, through the session's workspace fence. The result lists `restored` and `failed` honestly, and a `x/core/workspace-undo` ledger fact is written. An older daemon answers method-not-found.

The local App Server owner, launcher lock and discovery live under `<AGH_HOME>/daemon`, keyed by canonical home (including symlink aliases). Profile and data directory are validated configuration of that instance, not additional server identities. Stop the existing server before changing them. Upgrade from an older data-directory owner layout requires stopping that server first. Diagnostic journal lookup scans at most `4096 × limit` recent bytes (limit clamped to 1–1000), including exact-ID queries. An exact ID selects limit 1, so an older ID may be unavailable after restart even while its journal row exists. See [diagnostic retention](../guide/observability.md).

## Session jobs

`_agnes/v1/session.jobs.read({sessionId, jobId?})` returns a bounded job snapshot. `_agnes/v1/session.jobs.control({sessionId, commandId, operation, ...})` routes terminal effects through the existing service command journal. Both enforce session ownership. Control rejects another session's job and agent-owned jobs. Open and input honor the session permission policy; open uses the admitted cwd and fitted sandbox. Dock closure and session detachment never terminate jobs. See [workbench panels](../extend/workbench-panels.md).

`_agnes/v1/admin.feedback`: `list`, `put`, `withdraw`, `generate`. [Feedback service](../extend/feedback.md).
