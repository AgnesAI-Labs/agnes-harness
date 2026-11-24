import { join, resolve } from 'node:path'
import type {
  MemoryApprovalResult,
  MemoryEffectAdmission,
  MemoryFile,
  MemoryFilePort,
  MemoryProposal,
  MemorySettings,
  MemorySource,
} from '@agnes/extension-api'
import { appendAudit } from './audit.js'
import { formatLifecycleOmission } from './consistency.js'
import { diff, fault, file, validateContent } from './content.js'
import type { MetaStore } from './meta.js'
import type { ResolvedReadState, TurnOverlayInput } from './overlay.js'
import { markerLines, markerSet, paragraphTexts, parseParagraphs } from './paragraphs.js'
import { canonical, inside, type roots } from './paths.js'
import type { CommitIntent, MemoryClock, MemoryPipeline, ViewContext } from './pipeline.js'
import type { MemoryStore } from './store.js'
import { buildView, replaceInMemoryView } from './view.js'

export type FilePortDeps<TTurn extends TurnOverlayInput = TurnOverlayInput> = Readonly<{
  fallback: MemoryFilePort
  source: MemorySource
  signal: AbortSignal
  approve: (proposal: MemoryProposal) => Promise<MemoryApprovalResult>
  workspaceRoot: string
  paths: ReturnType<typeof roots>
  store: MemoryStore
  user: MemoryStore
  meta: MetaStore
  userMeta: MetaStore
  pipeline: MemoryPipeline
  clock: MemoryClock
  capture: (turn: number) => TTurn
  resolvedFor: (turn: TTurn) => ResolvedReadState
  target: (path: string) => string | undefined
  active: () => MemorySettings & { mode: 'ask' | 'auto' }
  viewCtx: (now: number, config?: MemorySettings) => ViewContext
}>

/** Build the agent-facing `MemoryFilePort` bound to a single turn, source, and pipeline. */
export function createFilePort<TTurn extends TurnOverlayInput>(deps: FilePortDeps<TTurn>): MemoryFilePort {
  const {
    fallback,
    source,
    signal,
    approve,
    workspaceRoot,
    paths,
    store,
    meta,
    userMeta,
    pipeline,
    clock,
    capture,
    resolvedFor,
    target,
    active,
    viewCtx,
  } = deps
  const get = (path: string): { shown: MemoryFile; state: ResolvedReadState } => {
    active()
    signal.throwIfAborted()
    const state = resolvedFor(capture(source.turn))
    const entry = state.files.find((item) => item.path === path)
    if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (!state.emptied.has(path)) validateContent(entry, store.configuration(), path === 'MEMORY.md')
    return { shown: state.agent.get(path) ?? entry, state }
  }
  const submit = (leaf: string, before: MemoryFile, candidate: MemoryFile) =>
    reviewAndCommit(
      { store, meta, pipeline, clock, root: paths.root, source, signal, approve, active, viewCtx },
      leaf,
      before,
      candidate,
    )

  return Object.freeze<MemoryFilePort>({
    async read(path, options) {
      const leaf = target(path)
      if (leaf === undefined) return fallback.read(path, options)
      const { shown } = get(leaf)
      const bytes = Buffer.from(shown.content)
      const offset = options?.offset ?? 0
      return bytes.subarray(offset, options?.limit === undefined ? undefined : offset + options.limit)
    },
    async revision(path) {
      const leaf = target(path)
      if (leaf === undefined) return fallback.revision?.(path)
      const { state } = get(leaf)
      return state.revision
    },
    async stat(path) {
      const leaf = target(path)
      if (leaf === undefined) return fallback.stat(path)
      const { shown } = get(leaf)
      return { size: shown.bytes, mtimeMs: 0, kind: 'file' }
    },
    async list(path) {
      const absolute = canonical(resolve(workspaceRoot, path))
      if (!inside(paths.protectedRoot, absolute)) return fallback.list(path)
      active()
      if (absolute !== paths.root) throw fault('MEMORY_SCOPE_DENIED')
      return resolvedFor(capture(source.turn)).files.map((entry) => ({
        name: entry.path,
        kind: 'file' as const,
      }))
    },
    async write(path, content) {
      const leaf = target(path)
      if (leaf === undefined) return fallback.write(path, content)
      active()
      signal.throwIfAborted()
      const turn = capture(source.turn)
      const state = resolvedFor(turn)
      const before = turn.files.find((entry) => entry.path === leaf) ?? file(leaf, '')
      // A whole file written from a view that leaves text out would silently drop that text.
      if (turn.readViews.get(leaf)?.hidden || state.views.get(leaf)?.hidden) {
        throw fault('MEMORY_HIDDEN_PARAGRAPHS')
      }
      const candidate = file(
        leaf,
        typeof content === 'string' ? content : Buffer.from(content).toString('utf8'),
      )
      if (
        markerSet(candidate.content) !== markerSet(before.content) ||
        (leaf === 'MEMORY.md' && parseParagraphs(candidate.content).anomalies.length)
      )
        throw fault('MEMORY_MARKER_CHANGED')
      // A managed paragraph's text changes only by exact replacement or the paragraph port.
      if (leaf === 'MEMORY.md' && paragraphTexts(candidate.content) !== paragraphTexts(before.content))
        throw fault('MEMORY_PARAGRAPH_TEXT_CHANGED')
      await submit(leaf, before, candidate)
    },
    async replaceExact(path, oldText, newText) {
      const leaf = target(path)
      if (leaf === undefined) {
        if (fallback.replaceExact) return fallback.replaceExact(path, oldText, newText)
        throw fault('MEMORY_SCOPE_DENIED')
      }
      active()
      signal.throwIfAborted()
      const before = store.read(leaf)
      const ranges = pipeline.collectHideRanges(before, viewCtx(clock()))
      const view = buildView(before, ranges, 'read', formatLifecycleOmission)
      const replaced = replaceInMemoryView(
        before.content,
        view,
        markerLines(before.content),
        oldText,
        newText,
        markerSet,
      )
      await submit(leaf, before, file(leaf, replaced))
    },
    ...(pipeline.recall
      ? {
          async recall(query) {
            active()
            signal.throwIfAborted()
            const state = resolvedFor(capture(source.turn))
            return pipeline.recall!(query, {
              revision: state.revision,
              workspaceViews: state.views,
              workspaceFiles: state.files,
              userViews: state.userViews,
              userFiles: state.userFiles,
              userEnabled: state.userEnabled,
              meta,
              userMeta,
              now: clock(),
            })
          },
        }
      : {}),
  })
}

function guardOrThrow(
  meta: MetaStore,
  pipeline: MemoryPipeline,
  intent: CommitIntent,
  now: number,
  ctx: ViewContext,
): void {
  const verdict = pipeline.checkGuards(intent, ctx)
  if (verdict.kind !== 'refuse') return
  try {
    appendAudit(meta, {
      at: new Date(now).toISOString(),
      path: intent.path,
      action: 'refused',
      code: verdict.code,
      origin: intent.origin,
      actor: intent.actor,
      ...(intent.source?.sessionKey ? { sessionKey: intent.source.sessionKey } : {}),
      beforeHash: intent.before.hash,
      afterHash: intent.candidate.hash,
    })
  } catch {
    // Best-effort refusal audit must not mask guard error.
  }
  throw Object.assign(
    fault(verdict.code),
    verdict.detail ? { message: `${verdict.code}: ${verdict.detail}` } : {},
  )
}

/** The shared agent write path: validate, pre-approval guards, review under ask, then CAS commit. */
async function reviewAndCommit(
  context: {
    store: MemoryStore
    meta: MetaStore
    pipeline: MemoryPipeline
    clock: MemoryClock
    root: string
    source: MemorySource
    signal: AbortSignal
    approve: (proposal: MemoryProposal) => Promise<MemoryApprovalResult>
    active: () => MemorySettings & { mode: 'ask' | 'auto' }
    viewCtx: (now: number, config?: MemorySettings) => ViewContext
  },
  leaf: string,
  before: MemoryFile,
  candidate: MemoryFile,
): Promise<void> {
  const { store, meta, pipeline, clock, source, signal, approve, active, viewCtx } = context
  const config = active()
  validateContent(candidate, config, leaf === 'MEMORY.md')
  // Check stale base hash before guards so concurrent external writes return MEMORY_CONFLICT.
  if (store.read(leaf).hash !== before.hash) throw fault('MEMORY_CONFLICT')
  const actor = source.toolUseId
    ? `agent:${source.sessionKey}:${source.toolUseId}`
    : `agent:${source.sessionKey}`
  const intent: CommitIntent = {
    origin: 'agent',
    actor,
    path: leaf,
    before,
    candidate,
    via: 'file',
    layer: 'workspace',
    source,
  }
  const guardNow = clock()
  guardOrThrow(meta, pipeline, intent, guardNow, viewCtx(guardNow, config))
  const proposal: MemoryProposal = Object.freeze({
    path: join(context.root, leaf),
    baseHash: before.hash,
    newHash: candidate.hash,
    diff: diff(before.content, candidate.content),
    source,
  })
  let admission: MemoryEffectAdmission | undefined
  if (config.mode === 'ask') {
    const result = await approve(proposal)
    if (result.status === 'approved') admission = result.admission
    if (result.status === 'rejected') throw fault('MEMORY_APPROVAL_REJECTED')
    if (result.status !== 'approved')
      throw Object.assign(fault('MEMORY_APPROVAL_UNANSWERED'), {
        reason: result.reason,
        message: `MEMORY_APPROVAL_UNANSWERED: ${result.reason}`,
      })
    signal.throwIfAborted()
    if (active().mode !== config.mode) throw fault('MEMORY_POLICY_CHANGED')
    if (store.read(leaf).hash !== before.hash) throw fault('MEMORY_CONFLICT')
    const recheckNow = clock()
    guardOrThrow(meta, pipeline, intent, recheckNow, viewCtx(recheckNow, store.configuration()))
  }
  signal.throwIfAborted()
  // A policy change during approval cannot silently convert it into an auto write.
  if (active().mode !== config.mode) throw fault('MEMORY_POLICY_CHANGED')
  await store.commit(
    candidate,
    before.hash,
    source,
    config.mode,
    signal,
    admission,
    (actualBefore, saved) => {
      pipeline.runObservers({ ...intent, before: actualBefore }, saved, viewCtx(clock()))
    },
  )
}
