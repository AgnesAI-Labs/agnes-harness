# API and schema reference

English | [简体中文](api.zh-CN.md)

<a id="api-与-schema-参考"></a>

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

Node transports include unix, stdio, and ws. Deployment contracts determine authentication, named-pipe process identity, TLS, and Origin checks. Start with automatic discovery through CLI/Web when possible. Embedders must retain handshake and server identity checks. The runnable [documentation smoke](../../tools/public-docs/smoke.mjs) demonstrates connections and package management using local fixture credentials and models. [Shared local acceptance](../../tools/acceptance/shared-local-delivery.test.ts) covers flows including distribution relocation. See [verification](../maintainers/verification.md) for reproduction and coverage.

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

Large inline attachments can arrive in a lean form: an `image` or `file` block whose base64 data exceeds 262,144 characters carries `dataOmitted: {bytes}` instead of `data`. UI projections always use this form. For worker-hosted sessions (the daemon's normal mode), live events and replays (`session.attach`, `session/load`) use it too, and ACP replays such a block as a text block naming its `session-image://` or `session-file://` reference; in-process sessions still send full rows. To read a stored row's full envelope as one JSONL line, call `_agnes/v1/session.exportRaw` with `sessionId`, the row's `seq`, and `offset` (start at 0). Each response carries `base64` for at most 8 MiB of the row's JSONL line (its JSON followed by a newline) and `nextOffset`, which is `null` after the last piece. Decode and concatenate the pieces. The daemon checks session ownership first; an unknown row is rejected with `INVALID_PARAMS` and reason `row-not-found`. No piece is served until the session's whole history has passed its integrity check; a history that failed it is refused with `SEMANTIC_REJECTED` and `code: 'E_LEDGER_INTEGRITY'`, the same as `_agnes/v1/session.verifyHistory`.

To download a user attachment itself, call `_agnes/v1/session.attachmentRead` with `sessionId`, the message `seq`, `kind` (`image` or `file`), `index` (its 1-based place among that message's blocks of the kind, as in `session-image://<seq>/<index>` and `session-file://<seq>/<index>`), `offset` (start at 0) and `length` (1 to 1,048,576 bytes). Add `thumbnail: true` to read an image's thumbnail instead. Only attachments in the session's own lane are served, and only objects the attachment store holds as user attachments or thumbnails: a digest naming any other stored object is refused as missing. Each response carries `mimeType`, `totalBytes` (the size of the whole attachment or thumbnail), `base64` for at most `length` bytes and, when the bytes come from a stored object, its `sha256` (for an old inline attachment, the digest of the copy the store keeps on first read). Read on from `offset` plus the decoded length until it reaches `totalBytes`. A window that holds the whole object is checked against its digest; a larger object is served by range unchecked, so check the assembled bytes against `sha256`. The daemon checks session ownership first and serves nothing until the session's history has been verified, as for `session.exportRaw`. An unknown attachment is rejected with `INVALID_PARAMS` and reason `attachment-not-found`; stored bytes that are gone or damaged are rejected with `SEMANTIC_REJECTED` and `code` `ATTACHMENT_MISSING` or `ATTACHMENT_CORRUPT`. Reading an old inline attachment this way never changes the session record.

To upload an attachment by reference, call `_agnes/v1/attachment.upload` for a session you own. `operation: 'limits'` answers `{ limits: { maxBytes, chunkBytes, maxConcurrent } }`. `start` takes a client-chosen UUID `uploadId`, `name`, `mimeType`, `size` and optionally `purpose: 'thumbnail'`, and answers `{ offset }` (starting the same `uploadId` again answers how far it got). `chunk` sends at most 1 MiB as `data` (base64) at exactly that `offset`, with the chunk's `sha256`; resending the last chunk is answered with the current offset. `status` answers the offset, `cancel` drops the upload, and `finish` (optionally with the whole object's `sha256`) stores it and answers `{ offset, attachment }`: a file reference block, an image reference block with the dimensions read from its header (a PNG or JPEG of at most 16 MiB; a larger one is returned as a file reference), or for a thumbnail (a JPEG of at most 256 KiB and 320 pixels per edge) `{ sha256, bytes, width, height }` to put in an image reference's `thumbnail`. Only the uploading session may send the returned block. In ACP `session/prompt` a reference travels as a `resource_link` to `artifact://<sha256>` whose `_meta["ai.agnes.harness"].attachment` carries the block. Refusals are `SEMANTIC_REJECTED` with `code` `UPLOAD_INVALID`, `UPLOAD_SIZE_LIMIT`, `UPLOAD_OFFSET`, `UPLOAD_HASH_MISMATCH`, `UPLOAD_INCOMPLETE`, `UPLOAD_CANCELLED`, `UPLOAD_BUSY`, `UPLOAD_EXPIRED` (also for an upload idle for 30 minutes), `UPLOAD_QUOTA`, `UPLOAD_UNAVAILABLE` or `UPLOAD_NOT_IMAGE`. A chunk refused with `UPLOAD_UNAVAILABLE` (the daemon could not store it) drops the upload: start it again from offset 0. A prompt, steer or follow-up whose attachment is refused is answered the same way, with `code` such as `ATTACHMENT_NOT_AUTHORIZED`, `ATTACHMENT_MISSING` or `UPLOAD_QUOTA`, and nothing is queued; an image a model request could not carry (over 16 MiB, or over 8 million pixels in one message) is `ATTACHMENT_IMAGE_TOO_LARGE`, and `ATTACHMENT_MISSING` names the attachment in `name`. Read `code`, not `reason`: for upload refusals `reason` repeats the code, for the others it is the code in kebab case. An upload with no chunk for 30 minutes, or open for 6 hours, is dropped; at most 4 uploads per session, 16 per principal and 64 per daemon are open at once, and a daemon handles 4 chunks at a time (`UPLOAD_BUSY`; retry after a short wait).

Writes commonly use clientId/commandId and expected revision/integrity to return a persistent operation receipt, followed by a final-state query. Receiving a receipt does not mean an effect succeeded. Do not change commandId to repeat an external effect with an unknown outcome.

<a id="skills-写接口"></a>

## Skill write interfaces

The Node SDK and server expose these management methods, subject to control-plane permissions:

| Node SDK / RPC | Inputs and result |
| --- | --- |
| `client.skills.remove` / `_agnes/v1/skills.remove` | profile, clientId, commandId, resourceId, expectedRevision; returns ResourceOperationReceipt |
| `client.skills.prioritySet` / `_agnes/v1/skills.priority.set` | The same fields plus expectedPriority and priority (integer 50–500 or null); returns ResourceOperationReceipt |

Both require admin authority and `resources.skills.write`. `remove` accepts only deletable workspace/user sources; `prioritySet` rejects runtime sources. Web BFF routes are `/admin/resources/api/skills/remove` and `/admin/resources/api/skills/priority`. They do not add direct resource-management permission to the browser SDK. Shell/TUI has no new commands with these names.

Use `client.resources.operation.get({ profile, operationId })` to wait for succeeded/failed, retain errors, and inspect actual state. Accepted deletion cannot be canceled. Saving priority does not change trust or enablement. See [Skills](../guide/skills.md) for deletion scope, persistent markers, and candidate replacement. Sources: [schema](../../packages/protocol/schema/resource-control.json), [method/permission table](../../packages/resource-control-contracts/src/resource-control.ts), [Node facade](../../packages/resource-control-client-node/src/resource-control.ts).

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
