import { join } from 'node:path'
import type {
  MemoryFile,
  MemoryParagraphChange,
  MemoryParagraphPort,
  MemoryParagraphValidity,
  MemoryProposal,
  MemorySource,
  MemoryValidityView,
} from '@agnes/extension-api'
import { checkProposalGuards, commitHooks } from './commit-hooks.js'
import { formatLifecycleOmission } from './consistency.js'
import { defaults, diff, fault, file } from './content.js'
import type { MetaStore } from './meta.js'
import { listParagraphs, paragraphCandidate } from './paragraph-port.js'
import { markerLines, omissionLine, parseParagraphs, validityOf } from './paragraphs.js'
import type { CommitIntent, MemoryClock, MemoryPipeline, ViewContext } from './pipeline.js'
import type { MemoryStore } from './store.js'
import { buildView, type HideRange } from './view.js'

const INDEX = 'MEMORY.md'
const SEPARATOR = '\n\n'

export type UserParagraphPortHooks = Readonly<{
  pipeline: MemoryPipeline
  userMeta: MetaStore
  clock: MemoryClock
}>

/**
 * A plain user file without lifecycle restrictions is shown byte for byte. Hand-written text
 * comes first, followed by valid saved sections in file order and a count of omitted sections.
 * This order keeps hand-written preferences visible when the injection budget cuts off the end.
 */
export type UserLayer = Readonly<{
  text: string
  /** True when the file holds any marker-like line. */
  managed: boolean
  /** Ids left out, sorted; damaged markers without an id are not listed. */
  omittedIds: readonly string[]
  handWritten: string
  sections: readonly string[]
}>

export function renderUserLayer(
  content: string,
  view: MemoryValidityView | undefined,
  nonManagedRanges: readonly HideRange[] = [],
): UserLayer {
  return layerOf(content, validityOf(view), nonManagedRanges)
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

function layerOf(
  content: string,
  validity: (id: string) => MemoryParagraphValidity,
  ranges: readonly HideRange[] = [],
): UserLayer {
  // Parse markers in the original bytes. An overlapping withdrawal must never turn a
  // damaged or expired managed section into ordinary hand-written text.
  const visible = (start: number, end: number) => {
    const text = content.slice(start, end)
    if (!ranges.length) return text
    const clipped = ranges
      .filter((r) => r.start < end && start < r.end)
      .map((r) => ({ ...r, start: r.start - start, end: r.end - start }))
    return clipped.length
      ? buildView(file(INDEX, text), clipped, 'note', formatLifecycleOmission).content
      : text
  }
  if (!markerLines(content).length) {
    const text = visible(0, content.length)
    return { text, managed: false, omittedIds: [], handWritten: text, sections: [] }
  }
  const { paragraphs, anomalies } = parseParagraphs(content)
  const valid = paragraphs.filter((paragraph) => validity(paragraph.id) === 'valid')
  // A delivered section is given to the model by the Host: it is neither shown here nor counted.
  const left = [
    ...anomalies,
    ...paragraphs.filter((paragraph) => {
      const answer = validity(paragraph.id)
      return answer !== 'valid' && answer !== 'delivered'
    }),
  ]
  const regions = [...paragraphs, ...anomalies]
    .map(({ start, end }) => ({ start, end }))
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((region, index, all) => index === 0 || region.start >= (all[index - 1]?.end ?? 0))
  let outside = ''
  let cursor = 0
  for (const region of regions) {
    outside += visible(cursor, region.start)
    cursor = Math.max(cursor, region.end)
  }
  outside += visible(cursor, content.length)
  const handWritten = outside
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/u, '')
    .replace(/\s+$/u, '')
  const sections = valid.map((paragraph) => {
    if (!ranges.length) return paragraph.text
    const start = content.indexOf('\n', paragraph.start) + 1
    return visible(start, start + paragraph.text.length)
  })
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
 * more than the default; not checked when the view `delivers`, since then no section is shown here), or
 * when the file would pass its index size or line cap; nothing is trimmed or merged. Credential-like content is refused as in workspace memory (`MEMORY_SECRET_LIKE_CONTENT`).
 */
export function userParagraphPort(
  user: MemoryStore,
  workspace: MemoryStore,
  view: MemoryValidityView | undefined,
  source: MemorySource,
  signal: AbortSignal,
  hooks: UserParagraphPortHooks,
): MemoryParagraphPort {
  if (
    source.maintenance !== undefined &&
    (typeof source.maintenance !== 'string' || !source.maintenance || source.maintenance.length > 128)
  )
    throw fault('MEMORY_INVALID_METADATA')
  const answer = validityOf(view)
  const made = new WeakMap<
    MemoryProposal,
    { candidate: MemoryFile; intent: CommitIntent; puts: ReadonlySet<string>; removalIds?: readonly string[] }
  >()
  const userCapacityError = (error: unknown): never => {
    if ((error as { code?: unknown })?.code === 'MEMORY_CONSOLIDATION_REQUIRED')
      throw fault('MEMORY_USER_BUDGET')
    throw error
  }
  const assertUserBudget = (candidate: MemoryFile, puts: ReadonlySet<string>) => {
    // A Host that gives the sections in force to the model itself shows none of them in this layer,
    // so a put takes no room in what the agent is shown.
    if (puts.size && view?.delivers !== true) {
      const budget = Math.min(workspace.configuration().userTokenBudget, defaults.userTokenBudget)
      const used = bytesOf(layerOf(candidate.content, (id) => (puts.has(id) ? 'valid' : answer(id))))
      if (used.handWritten + used.rsiInForce > budget) throw fault('MEMORY_USER_BUDGET')
    }
  }
  const actor = source.maintenance ? `host:${source.maintenance}` : `host:${source.sessionKey}`
  const makeContext = (now: number, allowOverCount = false): ViewContext => {
    const files = user.files('view', allowOverCount)
    return {
      layer: 'user',
      files,
      userFiles: files,
      userEnabled: true,
      now,
      validity: answer,
      meta: hooks.userMeta,
    }
  }
  return Object.freeze<MemoryParagraphPort>({
    async list() {
      signal.throwIfAborted()
      return listParagraphs(
        hooks.pipeline,
        () => makeContext(hooks.clock()),
        workspace.configuration(),
        user,
        answer,
      )
    },
    async propose(changes, baseHash) {
      signal.throwIfAborted()
      const before = user.read(INDEX)
      if (baseHash !== undefined && baseHash !== before.hash) throw fault('MEMORY_CONFLICT')
      const list: readonly MemoryParagraphChange[] = Array.isArray(changes)
        ? changes
        : [changes as MemoryParagraphChange]
      let change: ReturnType<typeof paragraphCandidate>
      try {
        change = paragraphCandidate(before, list, user.configuration())
      } catch (error) {
        return userCapacityError(error)
      }
      const { candidate } = change
      const puts = new Set(list.flatMap((change) => (change.op === 'put' ? [change.id] : [])))
      assertUserBudget(candidate, puts)
      const intent: CommitIntent = {
        origin: 'host',
        actor,
        path: INDEX,
        before,
        candidate,
        via: 'paragraph',
        layer: 'user',
        source,
        changes: list,
      }
      await checkProposalGuards(
        hooks.pipeline,
        intent,
        makeContext(hooks.clock(), !!change.removalIds),
        signal,
      )
      const proposal: MemoryProposal = Object.freeze({
        path: join(user.root, INDEX),
        baseHash: before.hash,
        newHash: candidate.hash,
        diff: diff(before.content, candidate.content),
        source,
      })
      made.set(proposal, { ...change, intent, puts })
      return proposal
    },
    async commit(proposal, admission) {
      signal.throwIfAborted()
      const entry = made.get(proposal)
      if (!entry) throw fault('MEMORY_PROPOSAL_UNKNOWN')
      const committed = await user.commit(
        entry.candidate,
        proposal.baseHash,
        source,
        false,
        signal,
        admission,
        commitHooks(
          hooks.pipeline,
          entry.intent,
          (now) => makeContext(now, !!entry.removalIds),
          hooks.clock,
          () => assertUserBudget(entry.candidate, entry.puts),
        ),
        userCapacityError,
        entry.removalIds,
      )
      return { hash: committed.hash }
    },
  })
}
