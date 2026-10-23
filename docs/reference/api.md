# API and schema reference

English | [简体中文](api.zh-CN.md)

<a id="api-与-schema-参考"></a>
[App Server v1](app-server.md) · JSONL, generated schemas, authentication and error envelopes.
[Protocol tiers](protocol-tiers.md) · which methods are the stable client contract and which are the evolving admin contract.

[Documentation](../README.md) · [Plugin boundaries](../develop/plugins.md)

When integrating AGH into an application, choose an entry point for your runtime first, then consult methods and schemas. This page lists traceable interface contracts. For your first plugin, start with the [tutorial](../develop/plugins.md).

APIs evolve with the source. `@agnes/*` packages currently resolve through the repository workspace. Use interfaces and examples matching your source revision.

<a id="选择正确入口"></a>

## Choose an entry point

| Consumer | Entry point | Typical operations |
| --- | --- | --- |
| Node client | Node conditional export of `@agnes/sdk` | createClient, session, config, packages, resources, skills, mcp |
| Browser host | `@agnes/sdk/browser` | Sessions and browser-allowed protocol methods, without Node management capabilities |
| Browser plugin | Host-supplied ClientContext | slots, session, theme, locale, commands, agnes.services |
| Backend Cordis plugin row | `@agnes/plugin-runtime` / Cordis Context | Config, inject/provide, effect, and the `ctx.tools`/`hooks`/`eventLog`/`self`/`skills`/`services`/`slots`/`projections`/`resources` facets |
| Plugin context facets | `PluginContextFacets` from `@agnes/extension-api` | Tools, hooks (all 16 events), ledger events, services, slots, projections, resources, providers and the plugin's own identity |

Current SDK exports: [index.node.ts](../../packages/sdk/src/index.node.ts) and [index.browser.ts](../../packages/sdk/src/index.browser.ts). Consume only package `exports`; source links explain behavior and do not authorize deep imports.

<a id="sdk-调用顺序"></a>

## SDK call sequence

A Node client with trusted connection configuration can follow this sequence. The deployment supplies `options`, including address and authentication:

```ts
import { createClient, type CreateClientOptions } from '@agnes/sdk'

async function listSessions(options: CreateClientOptions) {
  const client = createClient(options)
  try {
    await client.initialize()
    return await client.session.list({})
  } finally {
    await client.close()
  }
}
```

Create sessions with `client.session.new({ cwd, preset?, sessionKey? })`, or load them with `client.session.load(id, { cwd? })`. Execute with `session.prompt(text)` and cancel with `session.cancel()`. `session.prompt(input, { creditLimit?, maxSteps? })` lowers that one turn's credit ceiling and model-step ceiling; each needs the matching server capability and is refused otherwise (see [app server](app-server.md)). Register the workspace and handle permission requests according to current server requirements before business use. Closing the client cleans up the connection; it does not cancel backend tasks.

Read pending messages from the UI projection's `pendingInputs`. `session.removeQueued(itemId, { commandId? })` removes one pending message and returns its committed sequence through `_agnes/v1/submit` with kind `removeQueued`; `session.sendNow(itemId, { commandId? })` stops the current turn and prioritizes that queued message. Both require session ownership and reject an already claimed or missing item with `QUEUED_INPUT_GONE`. Removal preserves the other messages and does not start or stop a turn. Reuse the same command ID when retrying an unknown outcome.

Node transports include unix, stdio, and ws. Deployment contracts determine authentication, named-pipe process identity, TLS, and Origin checks. Start with automatic discovery through CLI/Web when possible. Embedders must retain handshake and server identity checks. The runnable [documentation smoke](../../tools/public-docs/smoke.mjs) demonstrates connections and package management using local fixture credentials and models. [Shared local acceptance](../../tools/acceptance/shared-local-delivery.e2e.test.ts) covers flows including distribution relocation. See [verification](../maintainers/verification.md) for reproduction and coverage.

<a id="协议方法分组"></a>

The in-process Core/Host session also exposes read-only `isRunning`, which reflects live run, step or resume work; a persisted turn awaiting recovery alone is not running. The daemon uses this state when refusing workspace removal.

## Protocol method groups

`client.session.open(id, { cwd?, signal?, onPermissionRequest?, onProgress? })` admits a session without replaying ACP history. It uses `_agnes/v1/session.open` (`sessionId`, optional workspace hint `cwd`, unique `requestId`) when `initialize.agentCapabilities._meta["ai.agnes.harness"].sessionOpen` is `true`; older daemons use `session/load`. A refusal never triggers fallback. Workspace, ownership, plugin recovery and complete history verification are the same as `session/load`. Ordinary ACP load still replays its full transcript. SDK recovery remembers the handle's opening mode.

ACP replay derives `_meta["ai.agnes.harness"].promptTurnId` from the historical `turn/start` sequence, preserving turn attribution across replay pages. Each load reconstructs its own metadata independently of the live feed; subsequent live updates retain their live turn attribution.

Web creates its SDK connection with `sessionRestoreHistory: 'none'` so newly created, forked and attached handles with a retained workspace hint also use admission-only recovery after worker reclamation. Other SDK clients default to `'full'`; an explicit `session.load` retains full replay for that handle even when the connection has a different recovery default.

`client.session.fork(parentId, at, { cwd? })` can retain the parent's known workspace hint for child recovery. Web supplies that hint for both turn and sidebar forks. It stays client-side; the backend derives the child's authority from the parent binding and verifies the hint again when restoring.

`client.session.btw(sessionId, question)` answers a side question (1-4000 characters) from the conversation so far, outside the transcript: nothing is written to the ledger except a `side-call` cost row, the model cannot call tools, and during a running turn only the completed turns before it are shown. One side question per session runs at a time (`SESSION_BUSY`); an exhausted per-request or tree budget is `SEMANTIC_REJECTED` with `reason: 'BUDGET'`, a deadline of 60 seconds is `REQUEST_TIMEOUT`. Once the model has been called, a timeout or failure still writes the `side-call` cost row (marked interrupted).

Read the bounded `projectUIOpening` after admission and subscribe from that opening's generation and exclusive `upto` cut; the open response is not a projection cursor. Register the permission handler before opening. Aborting the SDK call sends `session.loadingCancel` with the same request ID, releasing only that wait on that connection, without stopping a running turn. Omitting the ID retains the older connection/session-wide loading cancellation behavior. History previews and local drafts never authorize sending or answering approvals.

| Method family | Purpose |
| --- | --- |
| `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel` | Handshake and basic sessions |
| `session/update`, `session/request_permission` | Server notifications and approval requests |
| `_agnes/v1/session.*` | Attach, list, fork, projections, models/presets, controls, and other extensions |
| `_agnes/v1/submit`, `_agnes/v1/submit.ack` | Durable commands, including steering, follow-ups and queued-message edits; reuse commandId for retries |
| `_agnes/v1/config.*` | Configuration summary, testing, saving, and accounts; sensitive inputs must not become ordinary logs |
| `_agnes/v1/packages.*` | Package inspection, installation, governance, updates, and operation queries |
| Resource/Skill/MCP management methods | Separate control-plane permissions and revision checks; see the resource method table |
| `_agnes/v1/clientModules.*` | Rosters and constrained client relay, rather than arbitrary browser RPC |
| `_agnes/v1/extension.call` | Authorized extension-service calls |

Exact method names, directions, params/results, and management permissions are defined by the [method table](../../packages/protocol/src/methods.ts), [package-management table](../../packages/protocol/src/package-admin.ts), and [resource-management table](../../packages/protocol/src/resource-control.ts). Do not derive fields from the shorthand above.

`_agnes/v1/session.runtime` (SDK `client.session.runtime(id)`) answers what a session is actually running: its code generation (and a newer one, if any), composition, loop, the selected provider per kind with any `pending` change, seam bindings, resource revisions (skills, MCP servers, model route fingerprint), the effective approval mode, tool policy and sandbox, and `restartRequired` inputs. A `pending.effect` of `new-sessions` takes effect for sessions opened later; `restart-required` needs a daemon restart. The admin generation list (`plugins.generations`) also lists each generation's bound sessions.

For full recorded tool details, `_agnes/v1/session.readToolDetail` reads the tool call and its matching result on demand. Pass `sessionId` and the tool node's `seq` as `callSeq`; pass its `resultSeq` when available. Optional `offset` and `maxBytes` select a UTF-8 byte chunk, capped at 262,144 bytes per response. The result includes base64 `data`, `totalBytes`, and `nextOffset` (`null` after the last chunk). Decode and concatenate chunks before parsing the JSON object `{call, result?}`. The daemon authorizes access to the session before reading events. Both the RPC and the SDK's `Session.readToolDetail(callSeq, resultSeq?)` limit the complete serialized detail to 64 MiB; pagination does not permit larger records. The RPC rejects an oversized detail with `INVALID_PARAMS` and reason `detail-too-large`. The ordinary UI projection retains bounded previews and exposes `resultSeq` as an optional tool-node field.

For presented files, `_agnes/v1/session.deliverables` returns the sources a deliverables view needs without the full UI projection: the `present` tool calls that have a result. Pass `sessionId`, an exclusive `afterSeq` (default 0) and `limit` (1–200, default 100). Each item carries `callSeq`, `resultSeq`, `toolUseId`, the projection turn `turnId` whose seq range holds the call (when there is one), and `structured`, the result's structured data as recorded (absent when the result has none); validate it as you would a `readToolDetail` result. Calls and results pair exactly as the UI projection pairs tool nodes on the session's main lane, including continued and inherited turns, and the daemon reads only tool and turn rows to find them. Items are ordered by `resultSeq` and `upto` is the ledger seq the page covers. Truncated pages stop at a result boundary; pairing, result replacement and turn attribution are projected through that page's `upto`. A later page can return the same call with a newer result. Replacements also count toward the page's read budget, so a page may contain fewer than `limit` items. A page holds at most `limit` items and 262,144 bytes of JSON; when more remain, `nextAfterSeq` (equal to `upto`) is where the next page starts. To pick up later results, pass the last page's `upto` as `afterSeq`: a call whose result was replaced is returned again with the newer result, so keep items by `callSeq`. The daemon authorizes the session owner before reading. An `afterSeq` past the session's last seq is rejected with `INVALID_PARAMS` and reason `after-seq-out-of-range`, and a single item larger than a page with reason `deliverable-too-large`; read such a result with `readToolDetail`. The SDK method is `Session.deliverables({ afterSeq?, limit? })`.

Writes commonly use clientId/commandId and expected revision/integrity to return a persistent operation receipt, followed by a final-state query. Receiving a receipt does not mean an effect succeeded. Do not change commandId to repeat an external effect with an unknown outcome.

<a id="skills-写接口"></a>

## Skill write interfaces

The Node SDK and server expose these management methods, subject to control-plane permissions:

| Node SDK / RPC | Inputs and result |
| --- | --- |
| `client.skills.remove` / `_agnes/v1/skills.remove` | profile, clientId, commandId, resourceId, expectedRevision; returns ResourceOperationReceipt |
| `client.skills.prioritySet` / `_agnes/v1/skills.priority.set` | The same fields plus expectedPriority and priority (integer 50–500 or null); returns ResourceOperationReceipt |

Both require admin authority and `resources.skills.write`. `remove` accepts only deletable workspace/user sources; `prioritySet` rejects runtime sources. Web BFF routes are `/admin/resources/api/skills/remove` and `/admin/resources/api/skills/priority`. They do not add direct resource-management permission to the browser SDK. Shell/TUI has no new commands with these names.

Use `client.resources.operation.get({ profile, operationId })` to wait for succeeded/failed, retain errors, and inspect actual state. Accepted deletion cannot be canceled. Saving priority does not change trust or enablement. See [Skills](../guide/skills.md) for deletion scope, persistent markers, and candidate replacement. Sources: [schema](../../packages/protocol/schema/resource-control.json), [method/permission table](../../packages/resource-control-contracts/src/resource-control.ts), [Node facade](../../packages/sdk/src/resource-control.node.ts).

<a id="schema-导航"></a>

## Schema navigation

| Contract | Handwritten source |
| --- | --- |
| Core protocol / sessions | [agnes-v1](../../packages/protocol/schema/agnes-v1.json), [session-v1](../../packages/protocol/schema/session-v1.json) |
| Profiles / presets / models | [profile](../../packages/protocol/schema/profile.json), [preset](../../packages/protocol/schema/preset.json), [model](../../packages/protocol/schema/model.json) |
| Tools / extensions / hooks | [tooldef](../../packages/protocol/schema/tooldef.json), [extension-manifest](../../packages/protocol/schema/extension-manifest.json), [hooks](../../packages/protocol/schema/hooks.json) |
| Extension services / projections | [extension-service](../../packages/protocol/schema/extension-service.json), [projection](../../packages/protocol/schema/projection.json) |
| Package / resource control | [package-admin](../../packages/protocol/schema/package-admin.json), [resource-control](../../packages/protocol/schema/resource-control.json), [lockfile](../../packages/protocol/schema/lockfile.json) |
| Identity / deployment / surfaces | [authz](../../packages/protocol/schema/authz.json), [deploy-manifest](../../packages/protocol/schema/deploy-manifest.json), [surface](../../packages/protocol/schema/surface.json) |
| ACP provenance and deviations | [UPSTREAM](../../packages/protocol/schema/acp/UPSTREAM.md), [DEVIATIONS](../../packages/protocol/schema/acp/DEVIATIONS.md) |

Generated types are under [gen/ts](../../packages/protocol/gen/ts). Passing schema validation establishes shape. Implementations still verify cross-object relationships, authorization, transactions, and execution.

Model records optionally carry pi-ai `inputLimits`: `maxRequestBytes` and `images` (`maxPerMessage`, `maxPerRequest`, `resize`). `resize.maxBytes` counts Base64 bytes; `jpegQuality` uses 1–100. Omitted limits do not remove product caps. Image support still requires `image` in `input`.

`_agnes/v1/apis.list` includes `input` and optional `inputLimits` in each `profile.models` entry, so clients use the resolved model capabilities. Older servers may omit both fields; clients must not infer image support from a model name.

`ToolContext.session.readImages` is an optional Core-owned capability used by the built-in `read` tool. It accepts `{ path, offset?, limit? }` and returns a `ToolResult`. `session-image://list` pages the current session lane’s image originals; `session-image://<message-seq>/<image-index>` reads one original, and comma-separated references read a batch. Offsets and image indexes are one-based. Listing defaults to 20 entries and caps at 100. Reads cannot select another session or lane, observe future rows, or bypass model and runtime media limits. Tool cancellation also cancels image reads. Older runtimes omit the capability and `read` reports reloading as unavailable.

`ToolContext.fs.read` uses a zero-based byte offset and a maximum byte count enforced by the underlying read. Host's legacy line-window adapter remains one-based unless `unit: 'bytes'` is selected; providers without bounded reads refuse that mode rather than loading the whole file. `ToolContext.net.fetch` combines call cancellation, an optional caller signal and a deadline bounded by the call and remaining writer lease. An omitted timeout uses the call's default deadline; an explicit timeout cannot extend the call or lease. Expired calls refuse before opening a connection. Fetch providers must honor the supplied signal for the connection and response body, including locked readers; the default provider does so. Unread response bodies are also canceled when their call ends.

The default Host filesystem authorizes canonical names and executes reads, writes, metadata queries, enumeration, creation and removal through no-follow directory/file handles. An allowed symlink is resolved before authorization; a component replaced with a link afterwards is refused, with no path-based fallback. Local operations require the current `@agnes/system-node` native artifact. On POSIX, native entry points and the remote adapter reject paths containing unpaired Unicode surrogates with `EINVAL` before UTF-8 encoding can change the filename. The POSIX remote adapter requires Python 3 descriptor-relative filesystem operations and uses the transport's `exec` port, including stdin for binary writes, rather than path-based upload/download. Custom filesystem providers own the same boundary. Recursive removal refuses ancestors of hard-denied paths, including under full file access. This boundary covers filesystem tools; commands and MCP processes retain their separate sandbox contracts.

## Session approval grants

`client.approval.sessionGrants(sessionId)` (`_agnes/v1/approvalGrants.forSession`) lists every grant that lets the session's tools run without asking, for the session's owner. No tool, scope or policy version is named:

```json
{ "grants": [
  { "grantId": "dec-41", "lifetime": "session", "toolId": "shell", "scope": "tool:shell:execute", "createdAt": "2026-10-14T02:11:09.000Z", "issuer": { "id": "local", "org": "local", "role": "user", "deptPath": [], "attrs": {} } },
  { "grantId": "grant-9f2c", "lifetime": "always", "toolId": "write", "scope": "tool:write:execute", "policyVersion": "v1", "createdAt": "2026-10-12T08:00:00.000Z", "issuer": { "id": "local", "org": "local", "role": "user", "deptPath": [], "attrs": {} } }
] }
```

A `session` grant is an "allow for this session" answer still in force; an `always` grant belongs to the session's actor under its policy and also applies to that actor's other sessions. `client.approval.revokeSessionGrant(sessionId, grantId)` (`_agnes/v1/approvalGrants.revokeForSession`) revokes either kind by the listed id and returns the grant with `revokedAt`; an id that is not listed is refused with `APPROVAL_REJECTED`. Revocation is durable, including for a session grant after the session is reopened, and applies to later calls: the tool asks again. The fully-bound `approvalGrants.list` and `approvalGrants.revoke` remain for callers that already hold a tool, scope and policy version.

## Session bookmarks

A session keeps a list of bookmarked user prompts with its other presentation preferences, so every device sees the same list. `client.session.setBookmarks(sessionId, bookmarks)` (`_agnes/v1/session.bookmarks.set`, params `{ sessionId, bookmarks: string[] }`) replaces the whole list and returns `SessionPreferences`:

```json
{ "title": "Quarterly review", "archived": false, "bookmarks": ["01JABCDEFGHJKMNPQRSTVWXYZ0", "01JABCDEFGHJKMNPQRSTVWXYZ7"] }
```

Each id is the `id` of a `kind: "user"` node in the session's UI projection (`session.projectUI` / `session.view` `nodes`). It is the ledger id of the `user/message` event, a 26-character ULID that does not change across reloads, daemon restarts or forks. The list keeps the order given, drops repeats after their first place, holds at most 200 ids of 1–128 characters without control characters, and an empty list clears it; `bookmarks` is absent when nothing is bookmarked. Ids are not checked against the transcript, so a bookmark whose prompt is not shown is simply never matched. The call is idempotent and has the same owner and local-credential checks as `session.rename`; an unknown session is refused with `SESSION_NOT_FOUND`.

`session.list` rows (`SessionMeta`) carry the same `bookmarks` field next to `title` and `archived`. A fork copies the bookmarks whose prompt lies inside the history it inherits (at or before the fork boundary), in their order; the parent keeps its list. There is no session delete; an archived session keeps its bookmarks.

## Pinned sessions

`client.session.pin(sessionId, pinned)` (`_agnes/v1/session.pin`, params `{ sessionId, pinned: boolean }`) pins a session to the top of the sidebar and returns `SessionPreferences` with `pinnedAt`. Pinning an already pinned session keeps its original time; `pinned: false` clears it. An archived session is refused with `SESSION_ARCHIVED`, and archiving a session, including through `workspace.remove`, unpins it. The owner and local-credential checks are those of `session.rename`. `session.groups` lists a `pinned` group first; `session.list` with `sidebar: { groupId: "pinned" }` pages its sessions newest pin first, and workspace groups leave pinned sessions out. `SessionMeta` rows carry `pinnedAt`.

## Auxiliary model defaults

The local Node SDK exposes `client.config.modelSlots.get()` and `client.config.modelSlots.save({ revision, slots })`. Both return `{ revision, slots, auto? }`; `slots` accepts only `fast` and `verifier`, each an explicit `{ route, model }` or `null` (none). An omitted `verifier` retains preset-defined behavior. The save replaces the auxiliary-default map, checks the shared configuration revision and validates the exact route/model against the live Host catalog. Unsupported models and stale revisions are refused.

An omitted `fast` slot follows the default account. The result then carries `auto: { fast: { accountId, route, model } }`, and new sessions use that model for the fast slot:

```json
{ "revision": 4, "slots": { "verifier": null }, "auto": { "fast": { "accountId": "account-1f0c", "route": "agnes-ai", "model": "agnes-2.5-flash" } } }
```

The model is chosen from the default account's own models in their saved order: the lowest input plus output price when the provider publishes prices, otherwise the first model whose id names a light tier (`flash`, `mini`, `lite`, `haiku`, `nano`, `fast`, `small`). `auto.fast` is absent when the slot is set or `null`, when there is no enabled default account, or when neither rule finds a model; the preset's own fast slot then applies, as it does on a Host that does not serve the chosen model. `auto` is read-only: a save accepts and ignores it. The verifier slot is never automatic.

These methods are deployment-local administration, blocked in the browser SDK. Web uses the same-origin `/admin/api/model-slots` GET/POST bridge with the existing read/activate permissions and recovery read-only checks. Both responses contain only `{ revision, slots, auto?, canSave }`. Model options are fetched independently from `/admin/api/model-adapters` (read permission), so a slow or unavailable catalog does not block displaying or clearing saved slots. Saving still validates selected targets against the live catalog once; it does not fetch the catalog again for the response. Defaults are captured for new sessions; existing sessions use `Session.setModel({ slot, route, model })` for explicit overrides. See [reviewer setup](../guide/security.md).

## Agent resolution and launch

The SDK accepts `client.session.new({ cwd, agent: '@acme/kit#review' })`; embedders need no Bundle composition knowledge. `client.agents.resolve(ref)` (RPC `_agnes/v1/agents.resolve`) returns the exact selection, models, permission summary, source identities and a digest of the final effective configuration. Reviewed callers can pass `agentDigest` to refuse drift. An agent cannot be combined with `loop`, `bundles` or `preset`. Ordinary session/workspace authorization still applies; ordinary sessions keep their existing model fallback.

`session/new` accepts `_meta['ai.agnes.harness'].systemPromptAppend` (SDK: `client.session.new({ cwd, systemPromptAppend })`), owner text added to that one new session's system prompt. It is 1 to 8192 characters without NUL, and it is appended only: it is merged into the closing instruction `personaSuffix` (existing text, a blank line, then the append), so it appears in the `session/start` row's `systemPrompt.config` and hash, survives resume and fork, and adds no ledger event. It is refused (`SEMANTIC_REJECTED`, nothing created) when combined with `agent`, when the session already exists, when the package control plane reports configuration read-only (`E_ADMIN_READ_ONLY`, the same check as `systemPrompt.save`; an embedded endpoint has none to lock), when the deployment uses `fullOverride`, or when the merged `personaSuffix` would pass 8192 characters. A daemon without this field ignores it silently, so a client that needs the text reads `_agnes/v1/systemPrompt.get` with the new `sessionId` before its first prompt and checks the sections.

The host launch facade uses prepare → review → start(ticket, operationId). Start returns only a session ID and an optional reviewed draft. The user's edited draft goes through ordinary submit with its own commandId; retrying start never sends text. Failed or uncertain operations are not redispatched. Ordinary launches grant no install, trust or removal authority; example management remains restricted by a dependency-version-validated `exampleOf` relation.

The review binds the published execution configuration as well as package identities; raw row configuration stays in the backend. Its tool summary reflects admitted capabilities. After a lost start response, Web retains the ticket and operationId and reads the original receipt. A separate action explicitly warns that starting another session may create a duplicate.

At automation creation, `schedules.upsert` can accept a top-level `agent`. The backend lowers it into the existing new-session target (loop, bundle refs, preset, model). The saved target contains neither AgentRef nor launch. Runs never read launch again: each admits the saved selection against current trusted Bundle/Preset definitions and deployment configuration, then pins that session. Existing saved targets remain unchanged.
