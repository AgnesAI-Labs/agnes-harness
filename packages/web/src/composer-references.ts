import { fileReferenceBrowse } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import { createComposerReferences } from '@agnes/web-units/shell'

export { composerSkills } from './composer-skills.js'

/** Lazy session admission gives a new draft the same backend authority as a sent message. */
export function composerReferences(session: () => Promise<Session>, changed: () => void) {
  return createComposerReferences(async (query, signal) => {
    const current = await session()
    signal.throwIfAborted()
    const browse = fileReferenceBrowse(query)
    if (!browse) return current.searchReferences(query, { signal })
    const [result, listed] = await Promise.all([
      current.searchReferences(query, { signal }),
      current.workspaceBrowse(browse.path, { signal }),
    ])
    signal.throwIfAborted()
    const folders = listed.entries
      .filter(
        (entry) =>
          entry.kind === 'directory' && entry.name.toLowerCase().includes(browse.filter.toLowerCase()),
      )
      .map((entry) => {
        const id = browse.path ? `${browse.path}/${entry.name}` : entry.name
        return { source: 'folder', id, label: id }
      })
      .filter((item) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(item.id))
    return {
      items: [...folders, ...result.items].slice(0, 40),
      truncated: listed.truncated || result.truncated || folders.length + result.items.length > 40,
    }
  }, changed)
}
