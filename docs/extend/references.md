# Composer reference providers

English | [简体中文](references.zh-CN.md)

A reference is a locator (`{ source, id }`), not an access grant. The backend resolves it again when accepting a prompt or queued input. Resolved text stays in the user message as fenced **UNTRUSTED** data; providers cannot choose a message role or confer permissions. The ledger retains a SHA-256 source version and a truncation flag on the injected text block.

Type `@` in the composer to open the picker. `@file query` searches workspace paths fuzzily; `@session query` searches readable session titles and content through history-index. Use ↑/↓ to navigate, Enter or Tab to select, and Esc to close, or click a candidate. Each message can include eight references. The first search in a new draft creates its session to establish backend authority. Sent chips show sources; session chips link to their source session.

Register a provider from an in-process plugin row through the public author API:

```ts
import type { ReferenceResolver } from '@agnes/extension-api'
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
  inject: { providers: { required: true } },
  apply(ctx) { ctx.providers.register('reference-resolver', 'my-package', source) },
})
```

The `reference-resolver` kind has generation lifecycle scope. `ReferenceContext` exposes revocable workspace file and permission-filtered session ports plus an abort signal and deployment limits. Official `file` and `session` resolvers consume those same ports. Custom sources remain responsible for their own data authorization. Search results contain locators and display labels, never content grants.

Configure `referenceLimits` on the Host options (`maxBytes`, `maxSourceBytes`, `headFraction`). Limits apply to each excerpt in UTF-8 bytes. The default is 32 KiB, preserving 75% head and 25% tail around an explicit `[TRUNCATED: middle omitted]` marker. File sources have an additional 16 MiB read/hash cap. The service validates limits and always escapes JSON inside its UNTRUSTED fence, including fence-closing input.

Binary or over-limit files are refused. Ignore rules, sandbox authority and private state restrictions apply to both search and send-time reads. Session excerpts retain up to 24 indexed user/assistant messages and mark omissions. A file hash covers the complete file; a session hash covers its title and indexed excerpt snapshot at read time. Reference text is data in the user role, including any role or instruction strings inside the excerpt.
