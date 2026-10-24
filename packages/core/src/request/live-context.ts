import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import type { PromptSection } from './contribute.js'

/** Reserved family of trusted, durable notes; identity is independent of the current text. */
export const LIVE_CONTEXT_PREFIX = '[live context '
const CLEARED = 'This context item no longer applies.'

/**
 * Compare against model-visible history, never a process cache: forks/resumes inherit the
 * decision, and a masked note becomes eligible again after compaction. Missing items explicitly
 * clear their previous value. Each file can therefore be an independently changing context item.
 * The returned candidates use deriveRequest's ordinary latest-note dedup and sanitization path.
 */
export function liveContextNotes(sections: readonly PromptSection[], surface: readonly SurfaceNode[]) {
  const current = new Map<string, string>()
  for (const section of sections) {
    if (section.delivery !== 'live-note') continue
    const prefix = `${LIVE_CONTEXT_PREFIX}${sha256Hex(canonicalJson([section.source, section.id]))}]\n`
    current.set(prefix, `${section.id}\n${section.text || CLEARED}`)
  }
  for (const node of [...surface].reverse()) {
    if (node.kind !== 'user' || node.event.type !== 'user/message') continue
    if (node.event.origin !== 'system' || node.event.trust !== 'trusted') continue
    const data = node.event.data as { kind?: unknown; content?: Array<{ type?: string; text?: string }> }
    if (data.kind !== 'runtime_context') continue
    const text = data.content?.[0]?.text
    const prefix = typeof text === 'string' ? /^\[live context [a-f0-9]{64}\]\n/.exec(text)?.[0] : undefined
    if (prefix && !current.has(prefix)) {
      // Preserve the item's leading title (for example a repository path) in its tombstone.
      const [id = '', title = ''] = text?.slice(prefix.length).split('\n', 2) ?? []
      current.set(prefix, `${id}\n${title && title !== CLEARED ? `${title}\n` : ''}${CLEARED}`)
    }
  }
  return [...current].map(([prefix, text]) => ({ prefix, text, dedup: { kind: 'latest' as const } }))
}
