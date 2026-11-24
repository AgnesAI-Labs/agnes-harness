import type { CommitGuard } from './pipeline.js'
import { attributedBlocks, blockVersion, memoryBlocks } from './provenance.js'

export const humanGuard: CommitGuard = (intent, ctx) => {
  if (intent.origin === 'human') return { kind: 'allow' }
  const before = attributedBlocks(intent.before, ctx)
  const remaining = new Map<string, number>()
  for (const block of memoryBlocks(intent.candidate.content)) {
    const key = blockVersion(block)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  for (const block of before) {
    if (block.origin !== 'human') continue
    const key = blockVersion(block)
    const count = remaining.get(key) ?? 0
    if (!count)
      return {
        kind: 'refuse',
        code: intent.origin === 'agent' ? 'MEMORY_HUMAN_EDITED' : 'MEMORY_PARAGRAPH_EDITED',
        detail: 'A human-authored paragraph would be changed or removed. Edit it on the Memory page.',
      }
    remaining.set(key, count - 1)
  }
  if (intent.origin === 'host' && intent.via === 'paragraph') {
    const managed = new Map(before.filter((block) => block.id).map((block) => [block.id, block]))
    for (const change of intent.changes ?? []) {
      if (change.op !== 'put' || change.expectTextHash !== undefined) continue
      const found = managed.get(change.id)
      // Workspace attribution only returns 'host' for an exact match against the stored raw textHash.
      // User-layer origin is structural; an update there needs an explicit expected hash.
      if (found && (ctx.layer === 'user' || found.origin !== 'host'))
        return {
          kind: 'refuse',
          code: 'MEMORY_PARAGRAPH_EDITED',
          detail: 'The previous Host text cannot be verified for this paragraph.',
        }
    }
  }
  return { kind: 'allow' }
}
