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
import { checkProposalGuards, commitHooks, type VerifyCommitView } from './commit-hooks.js'
import { formatLifecycleOmission } from './consistency.js'
import { diff, fault, file, MemoryFault, validateContent } from './content.js'
import type { MetaStore } from './meta.js'
import type { TurnReadState } from './overlay.js'
import { markerLines, markerSet, paragraphTexts, parseParagraphs } from './paragraphs.js'
import { canonical, inside, type roots } from './paths.js'
import type { CommitIntent, MemoryClock, MemoryPipeline, ViewContext } from './pipeline.js'
import { liveDocuments } from './recall.js'
import type { MemoryStore } from './store.js'
import { buildView, replaceInMemoryView, retainedEditRanges } from './view.js'

const preEffectRefusals = new WeakMap<object, MemorySource>()

function markPreEffectRefusal(error: unknown, source: MemorySource): never {
  if (!(error instanceof MemoryFault) || error.code === 'MEMORY_COMMITTED_METADATA_FAILED') throw error
  // Issue a fresh error so a reused guard or cancellation error cannot carry another call's proof.
  const refusal = Object.freeze(Object.assign(fault(error.code), { message: error.message }))
  preEffectRefusals.set(refusal, { ...source })
  throw refusal
}

export function isMemoryPreEffectRefusal(
  error: unknown,
  source: Pick<MemorySource, 'sessionKey' | 'turn' | 'toolUseId'>,
): boolean {
  const bound = typeof error === 'object' && error !== null ? preEffectRefusals.get(error) : undefined
  return (
    !!bound &&
    typeof source.toolUseId === 'string' &&
    bound.sessionKey === source.sessionKey &&
    bound.turn === source.turn &&
    bound.toolUseId === source.toolUseId
  )
}

type FileChange = { before: MemoryFile; candidate: MemoryFile; verifyView: VerifyCommitView }

export type FilePortDeps<TTurn extends TurnReadState = TurnReadState> = Readonly<{
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
  resolvedFor: (turn: TTurn) => TurnReadState
  target: (path: string) => string | undefined
  active: () => MemorySettings & { mode: 'ask' | 'auto' }
  viewCtx: (now: number, config?: MemorySettings) => ViewContext
  userValidity: ViewContext['validity']
}>

/** Build the agent-facing `MemoryFilePort` bound to a single turn, source, and pipeline. */
export function createFilePort<TTurn extends TurnReadState>(deps: FilePortDeps<TTurn>): MemoryFilePort {
  const {
    fallback,
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
    userValidity,
  } = deps
  const source = Object.freeze({ ...deps.source })
  const get = (path: string): { shown: MemoryFile; state: TurnReadState } => {
    active()
    signal.throwIfAborted()
    const state = resolvedFor(capture(source.turn))
    const entry = state.files.find((item) => item.path === path)
    if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (path === 'MEMORY.md' && state.invalidIndexLimits)
      validateContent(entry, state.invalidIndexLimits, true)
    validateContent(entry, store.configuration(), path === 'MEMORY.md')
    return { shown: state.agent.get(path) ?? entry, state }
  }
  const submit = (leaf: string, prepare: () => FileChange) =>
    reviewAndCommit(
      { store, pipeline, clock, root: paths.root, source, signal, approve, active, viewCtx },
      leaf,
      prepare,
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
      return submit(leaf, () => {
        const turn = capture(source.turn)
        const state = resolvedFor(turn)
        const before = turn.files.find((entry) => entry.path === leaf) ?? file(leaf, '')
        // A whole file written from a view that leaves text out would silently drop that text.
        if (turn.readViews.get(leaf)?.hidden || state.readViews.get(leaf)?.hidden) {
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
        return {
          before,
          candidate,
          verifyView(current, ctx) {
            const view = buildView(
              current,
              pipeline.collectHideRanges(current, ctx),
              'read',
              formatLifecycleOmission,
            )
            if (view.hidden || resolvedFor(turn).readViews.get(leaf)?.hidden)
              throw fault('MEMORY_HIDDEN_PARAGRAPHS')
          },
        }
      })
    },
    async replaceExact(path, oldText, newText) {
      const leaf = target(path)
      if (leaf === undefined) {
        if (fallback.replaceExact) return fallback.replaceExact(path, oldText, newText)
        throw fault('MEMORY_SCOPE_DENIED')
      }
      return submit(leaf, () => {
        const turn = capture(source.turn)
        const state = resolvedFor(turn)
        const before = store.read(leaf)
        const prior = state.files.find((entry) => entry.path === leaf)
        if (leaf === 'MEMORY.md' && state.invalidIndexLimits && prior)
          validateContent(prior, state.invalidIndexLimits, true)
        if (!prior?.bytes && before.bytes) throw fault('MEMORY_REPLACE_NOT_FOUND')
        const replace = (current: MemoryFile, ctx: ViewContext, readState: TurnReadState) => {
          const omitted = new Set(readState.readViews.get(leaf)?.omitted)
          const ranges = pipeline.collectHideRanges(current, {
            ...ctx,
            validity: (id) => (omitted.has(id) ? 'expired' : ctx.validity(id)),
          })
          for (const { start, end, reason } of retainedEditRanges(
            prior?.content ?? '',
            current.content,
            readState.baseRanges.get(leaf) ?? [],
          )) {
            ranges.push({ start, end, reason, appliesTo: 'read' })
          }
          const view = buildView(current, ranges, 'read', formatLifecycleOmission)
          return replaceInMemoryView(
            current.content,
            view,
            markerLines(current.content),
            oldText,
            newText,
            markerSet,
          )
        }
        const candidate = file(leaf, replace(before, viewCtx(clock()), state))
        return {
          before,
          candidate,
          verifyView(current, ctx) {
            if (replace(current, ctx, resolvedFor(turn)) !== candidate.content) throw fault('MEMORY_CONFLICT')
          },
        }
      })
    },
    ...(pipeline.recall
      ? {
          async recall(query) {
            const settings = active()
            signal.throwIfAborted()
            const state = resolvedFor(capture(source.turn))
            return pipeline.recall!(query, {
              revision: state.revision,
              liveDocs(layer) {
                if (layer === 'workspace')
                  return liveDocuments(pipeline, viewCtx(clock(), settings), settings)
                const files = deps.user.files()
                return liveDocuments(
                  pipeline,
                  {
                    layer,
                    files,
                    userFiles: files,
                    userEnabled: settings.userEnabled,
                    now: clock(),
                    validity: userValidity,
                    meta: userMeta,
                  },
                  settings,
                )
              },
              workspaceViews: state.readViews,
              workspaceRanges: state.baseRanges,
              workspaceFiles: state.files,
              userViews: state.userReadViews,
              userRanges: state.userBaseRanges,
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

/** The shared agent write path: validate, pre-approval guards, review under ask, then CAS commit. */
async function reviewAndCommit(
  context: {
    store: MemoryStore
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
  prepare: () => FileChange,
): Promise<void> {
  const { store, pipeline, clock, source, signal, approve, active, viewCtx } = context
  const prepareProposal = async () => {
    const config = active()
    signal.throwIfAborted()
    const { before, candidate, verifyView } = prepare()
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
    await checkProposalGuards(pipeline, intent, viewCtx(guardNow, config), signal)
    const proposal: MemoryProposal = Object.freeze({
      path: join(context.root, leaf),
      baseHash: before.hash,
      newHash: candidate.hash,
      diff: diff(before.content, candidate.content),
      source,
    })
    return { config, intent, proposal, verifyView }
  }
  const refuse = (error: unknown): never => {
    if (signal.aborted) throw error
    return markPreEffectRefusal(error, source)
  }
  const { config, intent, proposal, verifyView } = await prepareProposal().catch(refuse)
  const { before, candidate } = intent
  let admission: MemoryEffectAdmission | undefined
  if (config.mode === 'ask') {
    let result: MemoryApprovalResult
    try {
      result = await approve(proposal)
    } catch (error) {
      // Approval is external to file validation and may have performed other work.
      if (typeof error === 'object' && error !== null) preEffectRefusals.delete(error)
      throw error
    }
    if (result.status === 'approved') admission = result.admission
    if (result.status === 'rejected') throw fault('MEMORY_APPROVAL_REJECTED')
    if (result.status !== 'approved')
      throw Object.assign(fault('MEMORY_APPROVAL_UNANSWERED'), {
        reason: result.reason,
        message: `MEMORY_APPROVAL_UNANSWERED: ${result.reason}`,
      })
  }
  await store.commit(
    candidate,
    before.hash,
    source,
    config.mode,
    signal,
    admission,
    commitHooks(pipeline, intent, viewCtx, clock, verifyView),
    refuse,
  )
}
