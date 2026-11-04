import { join } from 'node:path'
import type {
  MemoryFile,
  MemoryParagraphChange,
  MemoryParagraphPort,
  MemoryProposal,
  MemorySettings,
  MemorySource,
  MemoryValidityView,
} from '@agnes/extension-api'
import { diff, fault, file, validateContent } from './content.js'
import { applyParagraphChanges, parseParagraphs, validityOf } from './paragraphs.js'
import type { MemoryStore } from './store.js'

const INDEX = 'MEMORY.md'

/**
 * Paragraph access for the Host outside any turn. It reads the stored index each call, never a turn
 * snapshot. `list` works while memory is off (it is the Host's own read, like `inspect`); `propose`
 * and `commit` refuse while off. A proposal commits only through the port that made it and only
 * under the mode it was made in, so an auto proposal never lands once the mode has become ask. A
 * caller holding an approval from an earlier process proposes the same changes again and compares
 * the hashes; proposals are deterministic for the same stored file and changes.
 */
export function paragraphPort(
  store: MemoryStore,
  root: string,
  validity: MemoryValidityView | undefined,
  source: MemorySource,
  signal: AbortSignal,
): MemoryParagraphPort {
  // writer.json is read back with a 4 KiB cap; refuse a run id that could make it unreadable.
  if (
    source.maintenance !== undefined &&
    (typeof source.maintenance !== 'string' || !source.maintenance || source.maintenance.length > 128)
  )
    throw fault('MEMORY_INVALID_METADATA')
  const answer = validityOf(validity)
  const made = new WeakMap<MemoryProposal, { candidate: MemoryFile; mode: 'ask' | 'auto' }>()
  const enabled = (): MemorySettings & { mode: 'ask' | 'auto' } => {
    const config = store.configuration()
    if (config.mode === 'off') throw fault('MEMORY_DISABLED')
    return config as MemorySettings & { mode: 'ask' | 'auto' }
  }
  return Object.freeze<MemoryParagraphPort>({
    async list() {
      signal.throwIfAborted()
      const stored = store.read(INDEX)
      const paragraphs = parseParagraphs(stored.content).paragraphs.map(({ id, text }) =>
        Object.freeze({ id, text, validity: answer(id) }),
      )
      return Object.freeze({ hash: stored.hash, paragraphs: Object.freeze(paragraphs) })
    },
    async propose(changes, baseHash) {
      signal.throwIfAborted()
      const config = enabled()
      const before = store.read(INDEX)
      if (baseHash !== undefined && baseHash !== before.hash) throw fault('MEMORY_CONFLICT')
      const list: readonly MemoryParagraphChange[] = Array.isArray(changes)
        ? changes
        : [changes as MemoryParagraphChange]
      const candidate = file(INDEX, applyParagraphChanges(before.content, list))
      validateContent(candidate, config, true)
      const proposal: MemoryProposal = Object.freeze({
        path: join(root, INDEX),
        baseHash: before.hash,
        newHash: candidate.hash,
        diff: diff(before.content, candidate.content),
        source,
      })
      made.set(proposal, { candidate, mode: config.mode })
      return proposal
    },
    async commit(proposal, admission) {
      signal.throwIfAborted()
      const entry = made.get(proposal)
      if (!entry) throw fault('MEMORY_PROPOSAL_UNKNOWN')
      enabled()
      const committed = await store.commit(
        entry.candidate,
        proposal.baseHash,
        source,
        entry.mode,
        signal,
        admission,
      )
      return { hash: committed.hash }
    },
  })
}
