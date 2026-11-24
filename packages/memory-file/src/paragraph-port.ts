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
import { appendAudit } from './audit.js'
import { diff, fault, file, validateContent } from './content.js'
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

function actorOf(source: MemorySource): string {
  return source.maintenance ? `host:${source.maintenance}` : `host:${source.sessionKey}`
}

function recordRefused(
  meta: MetaStore,
  now: number,
  intent: CommitIntent,
  code: string,
  source: MemorySource,
) {
  try {
    appendAudit(meta, {
      at: new Date(now).toISOString(),
      path: INDEX,
      action: 'refused',
      code,
      origin: intent.origin,
      actor: intent.actor,
      sessionKey: source.sessionKey,
      ...(source.maintenance ? { maintenance: source.maintenance } : {}),
      beforeHash: intent.before.hash,
      afterHash: intent.candidate.hash,
    })
  } catch {
    // Best-effort refusal audit must not mask the guard refusal error.
  }
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
  hooks?: ParagraphPortHooks,
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
    ...(config.userEnabled ? { userFiles: hooks!.user.files() } : {}),
    userEnabled: config.userEnabled,
    now,
    validity: answer,
    meta: hooks!.meta,
  })
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
      if (hooks) {
        const now = hooks.clock()
        const verdict = hooks.pipeline.checkGuards(intent, makeContext(config, now))
        if (verdict.kind === 'refuse') {
          recordRefused(hooks.meta, now, intent, verdict.code, source)
          throw Object.assign(
            fault(verdict.code),
            verdict.detail ? { message: `${verdict.code}: ${verdict.detail}` } : {},
          )
        }
      }
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
        hooks
          ? (actualBefore, saved) => {
              const currentConfig = store.configuration()
              hooks.pipeline.runObservers(
                { ...entry.intent, before: actualBefore },
                saved,
                makeContext(currentConfig, hooks.clock()),
              )
            }
          : undefined,
      )
      return { hash: committed.hash }
    },
  })
}
