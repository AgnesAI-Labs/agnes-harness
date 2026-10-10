# API and schema reference

English | [简体中文](api.zh-CN.md)

<a id="api-与-schema-参考"></a>
[App Server v1](app-server.md) · JSONL, generated schemas, authentication and error envelopes.

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
| Backend Cordis plugin row | `@agnes/plugin-runtime` / Cordis Context | Config, inject/provide, effect, ctx.extension, ctx.skills, and ctx.services/slots/projections/resources on verified rows |
| Constrained extension capabilities | PluginExtensionAPI from `@agnes/extension-api` | Tools, `on` observation hooks, all `registerHook` categories, and events; service and similar contributions use row Cordis APIs |

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

Create sessions with `client.session.new({ cwd, preset?, sessionKey? })`, or load them with `client.session.load(id, { cwd? })`. Execute with `session.prompt(text)` and cancel with `session.cancel()`. Register the workspace and handle permission requests according to current server requirements before business use. Closing the client cleans up the connection; it does not cancel backend tasks.

Read pending messages from the UI projection's `pendingInputs`. `session.removeQueued(itemId, { commandId? })` removes one pending message and returns its committed sequence through `_agnes/v1/submit` with kind `removeQueued`; `session.sendNow(itemId, { commandId? })` stops the current turn and prioritizes that queued message. Both require session ownership and reject an already claimed or missing item with `QUEUED_INPUT_GONE`. Removal preserves the other messages and does not start or stop a turn. Reuse the same command ID when retrying an unknown outcome.

Node transports include unix, stdio, and ws. Deployment contracts determine authentication, named-pipe process identity, TLS, and Origin checks. Start with automatic discovery through CLI/Web when possible. Embedders must retain handshake and server identity checks. The runnable [documentation smoke](../../tools/public-docs/smoke.mjs) demonstrates connections and package management using local fixture credentials and models. [Shared local acceptance](../../tools/acceptance/shared-local-delivery.e2e.test.ts) covers flows including distribution relocation. See [verification](../maintainers/verification.md) for reproduction and coverage.

<a id="协议方法分组"></a>

## Protocol method groups

| Method family | Purpose |
| --- | --- |
| `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel` | Handshake and basic sessions |
| `session/update`, `session/request_permission` | Server notifications and approval requests |
| `_agnes/v1/session.*` | Attach, list, fork, projections, models/presets, follow-ups, and other extensions |
| `_agnes/v1/config.*` | Configuration summary, testing, saving, and accounts; sensitive inputs must not become ordinary logs |
| `_agnes/v1/packages.*` | Package inspection, installation, governance, updates, and operation queries |
| Resource/Skill/MCP management methods | Separate control-plane permissions and revision checks; see the resource method table |
| `_agnes/v1/clientModules.*` | Rosters and constrained client relay, rather than arbitrary browser RPC |
| `_agnes/v1/extension.call` | Authorized extension-service calls |

Exact method names, directions, params/results, and management permissions are defined by the [method table](../../packages/protocol/src/methods.ts), [package-management table](../../packages/protocol/src/package-admin.ts), and [resource-management table](../../packages/protocol/src/resource-control.ts). Do not derive fields from the shorthand above.

For full recorded tool details, `_agnes/v1/session.readToolDetail` reads the tool call and its matching result on demand. Pass `sessionId` and the tool node's `seq` as `callSeq`; pass its `resultSeq` when available. Optional `offset` and `maxBytes` select a UTF-8 byte chunk, capped at 262,144 bytes per response. The result includes base64 `data`, `totalBytes`, and `nextOffset` (`null` after the last chunk). Decode and concatenate chunks before parsing the JSON object `{call, result?}`. The daemon authorizes access to the session before reading events. Both the RPC and the SDK's `Session.readToolDetail(callSeq, resultSeq?)` limit the complete serialized detail to 64 MiB; pagination does not permit larger records. The RPC rejects an oversized detail with `INVALID_PARAMS` and reason `detail-too-large`. The ordinary UI projection retains bounded previews and exposes `resultSeq` as an optional tool-node field.

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

## Auxiliary model defaults

The local Node SDK exposes `client.config.modelSlots.get()` and `client.config.modelSlots.save({ revision, slots })`. Both return `{ revision, slots }`; `slots` accepts only `fast` and `verifier`, each an explicit `{ route, model }` or `null` (unset). Omitted slots retain preset-defined behavior. The save replaces the auxiliary-default map, checks the shared configuration revision and validates the exact route/model against the live Host catalog. Unsupported models and stale revisions are refused.

These methods are deployment-local administration, blocked in the browser SDK. Web uses the same-origin `/admin/api/model-slots` GET/POST bridge with the existing read/activate permissions and recovery read-only checks. Defaults are captured for new sessions; existing sessions use `Session.setModel({ slot, route, model })` for explicit overrides. See [reviewer setup](../guide/security.md).
