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
import { checkProposalGuards, commitHooks } from './commit-hooks.js'
import { buildIndexView, nonManaged } from './consistency.js'
import { diff, fault, file, validateContent } from './content.js'
import { annotations } from './expiry-annotation.js'
import type { MetaStore } from './meta.js'
import { applyParagraphChanges, parseParagraphs, validityOf } from './paragraphs.js'
import type { CommitIntent, MemoryClock, MemoryPipeline, ViewContext } from './pipeline.js'
import type { MemoryStore } from './store.js'

const INDEX = 'MEMORY.md'

export type ParagraphPortHooks = Readonly<{
  pipeline: MemoryPipeline
  meta: MetaStore
  user: MemoryStore
  userValidity?: MemoryValidityView
  clock: MemoryClock
}>

/** Project only raw body segments. Notices synthesized for reads never become saved experience. */
export function listParagraphs(pipeline: MemoryPipeline, context: ViewContext) {
  const stored = context.files.find((entry) => entry.path === INDEX) ?? file(INDEX, '')
  const ranges = pipeline.collectHideRanges(stored, context).filter(nonManaged)
  const view = buildIndexView(stored, ranges)
  const deadlines = [...annotations(stored.content)].filter((a) => a.expiresAt > context.now)
  const paragraphs = parseParagraphs(stored.content).paragraphs.map(({ id, text, start }) => {
    const from = stored.content.indexOf('\n', start) + 1
    const to = from + text.length
    let body = ''
    for (const segment of view.segments) {
      if (segment.raw === undefined) continue
      const left = Math.max(from, segment.raw)
      const right = Math.min(to, segment.raw + segment.length)
      if (left < right) body += stored.content.slice(left, right)
    }
    let nextExpiry: number | undefined
    for (const { start, end, expiresAt } of deadlines) {
      if (start < to && end > from) nextExpiry = Math.min(nextExpiry ?? expiresAt, expiresAt)
    }
    return Object.freeze({
      id,
      text,
      validity: context.validity(id),
      visibleText: body.trim() ? body : null,
      ...(nextExpiry !== undefined ? { nextExpiry } : {}),
    })
  })
  return Object.freeze({ hash: stored.hash, content: stored.content, paragraphs: Object.freeze(paragraphs) })
}

function actorOf(source: MemorySource): string {
  return source.maintenance ? `host:${source.maintenance}` : `host:${source.sessionKey}`
}

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
  hooks: ParagraphPortHooks,
): MemoryParagraphPort {
  // writer.json is read back with a 4 KiB cap; refuse a run id that could make it unreadable.
  if (
    source.maintenance !== undefined &&
    (typeof source.maintenance !== 'string' || !source.maintenance || source.maintenance.length > 128)
  )
    throw fault('MEMORY_INVALID_METADATA')
  const answer = validityOf(validity)
  const made = new WeakMap<
    MemoryProposal,
    { candidate: MemoryFile; mode: 'ask' | 'auto'; intent: CommitIntent }
  >()
  const enabled = (): MemorySettings & { mode: 'ask' | 'auto' } => {
    const config = store.configuration()
    if (config.mode === 'off') throw fault('MEMORY_DISABLED')
    return config as MemorySettings & { mode: 'ask' | 'auto' }
  }
  const makeContext = (config: MemorySettings, now: number): ViewContext => ({
    layer: 'workspace',
    files: store.files(),
    ...(config.userEnabled ? { userFiles: hooks.user.files() } : {}),
    userEnabled: config.userEnabled,
    now,
    validity: answer,
    meta: hooks.meta,
  })
  return Object.freeze<MemoryParagraphPort>({
    async list() {
      signal.throwIfAborted()
      return listParagraphs(hooks.pipeline, makeContext(store.configuration(), hooks.clock()))
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
      const intent: CommitIntent = {
        origin: 'host',
        actor: actorOf(source),
        path: INDEX,
        before,
        candidate,
        via: 'paragraph',
        layer: 'workspace',
        source,
        changes: list,
      }
      await checkProposalGuards(hooks.pipeline, intent, makeContext(config, hooks.clock()), signal)
      const proposal: MemoryProposal = Object.freeze({
        path: join(root, INDEX),
        baseHash: before.hash,
        newHash: candidate.hash,
        diff: diff(before.content, candidate.content),
        source,
      })
      made.set(proposal, { candidate, mode: config.mode, intent })
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
        commitHooks(
          hooks.pipeline,
          entry.intent,
          (now) => makeContext(store.configuration(), now),
          hooks.clock,
        ),
      )
      return { hash: committed.hash }
    },
  })
}
