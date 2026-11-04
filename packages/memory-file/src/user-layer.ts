import { join } from 'node:path'
import type {
  MemoryFile,
  MemoryParagraphChange,
  MemoryParagraphPort,
  MemoryParagraphValidity,
  MemoryProposal,
  MemorySettings,
  MemorySource,
  MemoryValidityView,
} from '@agnes/extension-api'
import { defaults, diff, fault, file, validateContent } from './content.js'
import {
  applyParagraphChanges,
  markerLines,
  omissionLine,
  parseParagraphs,
  validityOf,
} from './paragraphs.js'
import type { MemoryStore } from './store.js'

const INDEX = 'MEMORY.md'
const SEPARATOR = '\n\n'

/**
 * User memory as the agent reads it. A file without any marker is shown exactly as stored. Otherwise the
 * hand-written text comes first (the file with every saved section and every damaged marker region cut
 * out), then the saved sections in force, in file order, as their text only, then one line counting the
 * sections left out (past their review date, or nothing vouches for them). Hand-written text is never
 * pushed out by a saved section: whatever the budget cuts from the end is saved text first.
 */
export type UserLayer = Readonly<{
  text: string
  /** True when the file holds any marker-like line; only then may revision inputs change. */
  managed: boolean
  /** Ids left out, sorted; damaged markers without an id are not listed. */
  omittedIds: readonly string[]
  handWritten: string
  sections: readonly string[]
}>

export function renderUserLayer(content: string, view: MemoryValidityView | undefined): UserLayer {
  return layerOf(content, validityOf(view))
}

/**
 * The bytes the hand-written text and the saved sections in force take in what the agent is shown (each
 * section with the blank line before it), the same measure the snapshot is cut to its budget by.
 */
export function userLayerBytes(
  content: string,
  view: MemoryValidityView | undefined,
): { handWritten: number; rsiInForce: number } {
  return bytesOf(layerOf(content, validityOf(view)))
}

function bytesOf(layer: UserLayer): { handWritten: number; rsiInForce: number } {
  return {
    handWritten: Buffer.byteLength(layer.handWritten),
    rsiInForce: layer.sections.reduce((n, text) => n + Buffer.byteLength(SEPARATOR + text), 0),
  }
}

function layerOf(content: string, validity: (id: string) => MemoryParagraphValidity): UserLayer {
  if (!markerLines(content).length)
    return { text: content, managed: false, omittedIds: [], handWritten: content, sections: [] }
  const { paragraphs, anomalies } = parseParagraphs(content)
  const valid = paragraphs.filter((paragraph) => validity(paragraph.id) === 'valid')
  const left = [...anomalies, ...paragraphs.filter((paragraph) => validity(paragraph.id) !== 'valid')]
  const regions = [...paragraphs, ...anomalies]
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((region, index, all) => index === 0 || region.start >= (all[index - 1]?.end ?? 0))
  let outside = ''
  let cursor = 0
  for (const region of regions) {
    outside += content.slice(cursor, region.start)
    cursor = Math.max(cursor, region.end)
  }
  outside += content.slice(cursor)
  const handWritten = outside
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/u, '')
    .replace(/\s+$/u, '')
  const sections = valid.map((paragraph) => paragraph.text)
  const count = new Set(left.map(({ start, end }) => `${start}:${end}`)).size
  const text = [handWritten, ...sections, ...(count ? [omissionLine(count)] : [])]
    .filter((piece) => piece.length > 0)
    .join(SEPARATOR)
  return {
    text: text ? `${text}\n` : '',
    managed: true,
    omittedIds: [...new Set(left.flatMap((entry) => (entry.id ? [entry.id] : [])))].sort(),
    handWritten,
    sections,
  }
}

/**
 * The managed section write for user memory: the paragraph port over the user `MEMORY.md`. It works
 * whatever the workspace's memory mode, since every workspace reads the same file. A put is refused with
 * `MEMORY_USER_BUDGET` when the hand-written text, the sections in force and the sections being put would
 * take more than the user budget in what the agent is shown (this workspace's `userTokenBudget`, never
 * more than the default), or when the file would pass its index size or line cap; nothing is trimmed or
 * merged. Credential-like content is refused as in workspace memory (`MEMORY_SECRET_LIKE_CONTENT`).
 */
export function userParagraphPort(
  user: MemoryStore,
  workspace: MemoryStore,
  view: MemoryValidityView | undefined,
  source: MemorySource,
  signal: AbortSignal,
): MemoryParagraphPort {
  if (
    source.maintenance !== undefined &&
    (typeof source.maintenance !== 'string' || !source.maintenance || source.maintenance.length > 128)
  )
    throw fault('MEMORY_INVALID_METADATA')
  const answer = validityOf(view)
  const made = new WeakMap<MemoryProposal, MemoryFile>()
  return Object.freeze<MemoryParagraphPort>({
    async list() {
      signal.throwIfAborted()
      const stored = user.read(INDEX)
      const paragraphs = parseParagraphs(stored.content).paragraphs.map(({ id, text }) =>
        Object.freeze({ id, text, validity: answer(id) }),
      )
      return Object.freeze({ hash: stored.hash, paragraphs: Object.freeze(paragraphs) })
    },
    async propose(changes, baseHash) {
      signal.throwIfAborted()
      const config: MemorySettings = workspace.configuration()
      const limits: MemorySettings = user.configuration()
      const before = user.read(INDEX)
      if (baseHash !== undefined && baseHash !== before.hash) throw fault('MEMORY_CONFLICT')
      const list: readonly MemoryParagraphChange[] = Array.isArray(changes)
        ? changes
        : [changes as MemoryParagraphChange]
      const candidate = file(INDEX, applyParagraphChanges(before.content, list))
      try {
        validateContent(candidate, limits, true)
      } catch (error) {
        if ((error as { code?: unknown }).code === 'MEMORY_CONSOLIDATION_REQUIRED')
          throw fault('MEMORY_USER_BUDGET')
        throw error
      }
      const puts = new Set(list.flatMap((change) => (change.op === 'put' ? [change.id] : [])))
      if (puts.size) {
        const budget = Math.min(config.userTokenBudget, defaults.userTokenBudget)
        const used = bytesOf(layerOf(candidate.content, (id) => (puts.has(id) ? 'valid' : answer(id))))
        if (used.handWritten + used.rsiInForce > budget) throw fault('MEMORY_USER_BUDGET')
      }
      const proposal: MemoryProposal = Object.freeze({
        path: join(user.root, INDEX),
        baseHash: before.hash,
        newHash: candidate.hash,
        diff: diff(before.content, candidate.content),
        source,
      })
      made.set(proposal, candidate)
      return proposal
    },
    async commit(proposal, admission) {
      signal.throwIfAborted()
      const candidate = made.get(proposal)
      if (!candidate) throw fault('MEMORY_PROPOSAL_UNKNOWN')
      const committed = await user.commit(candidate, proposal.baseHash, source, false, signal, admission)
      return { hash: committed.hash }
    },
  })
}
