# Composer reference providers

English | [简体中文](references.zh-CN.md)

A reference is a locator (`{ source, id }`), not an access grant. The backend resolves it again when accepting a prompt or queued input. Resolved text stays in the user message as fenced **UNTRUSTED** data; providers cannot choose a message role or confer permissions. The ledger retains a SHA-256 source version and a truncation flag on the injected text block.

Type `@` in the composer to open the picker. An empty `@` lists the workspace root's immediate files and folders alongside other reference sources. `@file query` searches workspace paths fuzzily; `@session query` searches readable session titles and content through history-index. A path ending in `/`, such as `@src/`, lists that folder's immediate children. `@src/ma` filters only names in `src/`. Backslashes in path queries are accepted as separators; quote a path containing spaces, for example `@"my folder/`. The picker never follows a folder's descendants during browsing. The browser client opens a folder with Enter or a click; Tab selects its location link. Use ↑/↓ to navigate and Esc to close. Each message can include eight content references. The first search in a new draft creates its session to establish backend authority. Sent chips show sources; session chips link to their source session.

The empty `@` menu defaults to **Overview**, a compact view of files and sessions. Its layout control can switch to **Categories** for source tabs or **Navigation** to choose a source first. Overview's **View all** expands a group; Categories includes an **All** view for additional providers. These controls only change how the current candidates are displayed. Typing a query continues to use the same search and selection behavior.

`Session.workspaceBrowse(path, { signal })` provides the same one-level, strictly checked listing without Git status work. `Session.searchReferences(query, { signal })` can cancel an in-flight search. Search cancellation is scoped to the request and does not cancel the session or a prompt. Older clients can continue using the original search result shape and `workspaceList(path)` behavior.

Plain file keyword search enumerates path candidates on demand with the bundled ripgrep binary; it does not maintain a resident index or file watcher. Before displaying a candidate, the worker applies the current ignore rules, private-path restrictions, symlink checks and workspace authority. Enumeration has a bounded output budget and reports partial results when that budget is reached. Selection remains a locator and is checked again at send time.

Register a provider from an in-process plugin row through the public author API:

```ts
import { referenceResolverKind, type ReferenceResolver } from '@agnes/extension-api'
import { definePlugin, defineProvider } from '@agnes/plugin-runtime'

const source = defineProvider('reference-resolver', {
  id: 'kb',
  version: '1.0.0',
  async search(query, context) {
    context.signal.throwIfAborted()
    return { items: [], truncated: false }
  },
  async resolve(id, context) {
    // Check the authenticated reader's current permission in your backend.
    // Return data, a SHA-256 version of the full source, and whether it was shortened.
    throw new Error('Document unavailable')
  },
} satisfies ReferenceResolver)

export const references = definePlugin({
  apply(ctx) { ctx.providers.register(referenceResolverKind, source) },
})
```

The `reference-resolver` kind has generation lifecycle scope. `ReferenceContext` exposes revocable workspace file and permission-filtered session ports plus an abort signal and deployment limits. Official `file` and `session` resolvers consume those same ports. Custom sources remain responsible for their own data authorization. Search results contain locators and display labels, never content grants.

Configure `referenceLimits` on the Host options (`maxBytes`, `maxSourceBytes`, `headFraction`). Limits apply to each excerpt in UTF-8 bytes. The default is 32 KiB, preserving 75% head and 25% tail around an explicit `[TRUNCATED: middle omitted]` marker. File sources have an additional 16 MiB read/hash cap. The service validates limits and always escapes JSON inside its UNTRUSTED fence, including fence-closing input.

Binary or over-limit files are refused. Ignore rules, sandbox authority and private state restrictions apply to both search and send-time reads. Session excerpts retain up to 24 indexed user/assistant messages and mark omissions. A file hash covers the complete file; a session hash covers its title and indexed excerpt snapshot at read time. Reference text is data in the user role, including any role or instruction strings inside the excerpt.

Resolved reference blocks are ledgered separately as `system/untrusted` messages. Human text retains `principal/trusted` provenance. Requests wrap references in untrusted envelopes and the reviewer excludes them from human instructions. The accepted input seeds turn taint on `turn/start`, even though input messages precede that event.

## Stored attachment contract

Stored originals use the existing `resource_link` content block with `uri: artifact://<sha256>`,
`name`, `mimeType` and an `attachment` object. `attachment.artifact` is the public
`ArtifactRef` (`sha256`, `size`, `mime`); the URI and MIME must agree exactly. Optional
`image: {width, height}` marks an image original. `thumbnail` is a separate `ArtifactRef`
for a small PNG/JPEG, authorized and checked independently. `receiptId` identifies one
pending upload; it grants access only in its original session and lane. A digest alone
never grants access. Clients may retain these blocks without loading the bytes.

The optional `ArtifactsSeam.attachments` capability owns bytes and durable, independent
upload receipts through the selected persistence provider. Core accepts an exact reference
already visible in its session/lane (including a fork's visible prefix), or a matching pending
receipt. It confirms receipts only after the inbox commits. A failed or cancelled admission
discards its own receipts; another upload of identical bytes remains independent. GC must
include inboxes, fork prefixes, originals, thumbnails, request media, derivations and pending
receipts; an incomplete root snapshot must block deletion.

Providers may implement optional `AttachmentStore.storeStream(scope, source, artifact, signal)`
to consume chunks with backpressure and verify the exact SHA-256 and size before publishing.
Chunks may be reused after consumption; do not retain them. The default private local store
uses this path, and session intake spools to a private temporary file that is removed on finish,
cancel, expiry or close. Providers exposing only `store` keep the legacy byte-buffer fallback.
Scoped receipts, quotas and GC roots apply equally to both paths.

`ToolContext.fs.create` is optional exclusive creation: it rejects existing entries and
symlink ancestors, applies the normal workspace write authorization and returns the actual
written `size` and `sha256`. It must never fall back to overwriting `write`. This is the
capability used for copying a session original with `read.save_to`.

Attachment failures expose a stable `AttachmentError.code`; admission preserves it in
`CoreError.detail.code`. Clients localize the code, not native filesystem or decoder errors.
