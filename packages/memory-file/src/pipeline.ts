import type {
  MemoryFile,
  MemoryParagraphChange,
  MemoryParagraphValidity,
  MemoryRecallQuery,
  MemoryRecallResult,
  MemorySource,
} from '@agnes/extension-api'
import { appendAudit } from './audit.js'
import { registerLifecycle } from './consistency.js'
import type { MetaStore } from './meta.js'
import { managedParagraphRanges } from './paragraphs.js'
import { registerMemoryProtection } from './preference-conflict.js'
import { registerRetrieval } from './recall.js'
import type { HideRange, MemoryView } from './view.js'

export type MemoryClock = () => number

export type ViewContext = Readonly<{
  layer: 'workspace' | 'user'
  files: readonly MemoryFile[]
  userFiles?: readonly MemoryFile[]
  userEnabled?: boolean
  now: number
  validity: (id: string) => MemoryParagraphValidity
  meta: MetaStore
}>

/** Pure filter returning character ranges to hide from views; same input must yield same output. */
export type ViewFilter = (entry: MemoryFile, ctx: ViewContext) => readonly HideRange[]

export type NextExpiryProvider = (files: readonly MemoryFile[], ctx: ViewContext) => number | undefined

export type CommitIntent = Readonly<{
  origin: 'agent' | 'host' | 'human'
  actor: string
  path: string
  before: MemoryFile
  candidate: MemoryFile
  via: 'file' | 'paragraph' | 'edit'
  layer?: 'workspace' | 'user'
  source?: MemorySource
  changes?: readonly MemoryParagraphChange[]
}>

export type GuardVerdict =
  | Readonly<{ kind: 'allow' }>
  | Readonly<{ kind: 'refuse'; code: string; detail: string }>

export type CommitGuard = (intent: CommitIntent, ctx: ViewContext) => GuardVerdict

/** Executed under the store commit lock after the file lands on disk; throwing raises MEMORY_COMMITTED_METADATA_FAILED. */
export type CommitObserver = (intent: CommitIntent, committed: MemoryFile, ctx: ViewContext) => void

export type RecallEnvironment = Readonly<{
  revision: string
  workspaceViews: ReadonlyMap<string, MemoryView>
  workspaceFiles: readonly MemoryFile[]
  userViews: ReadonlyMap<string, MemoryView>
  userFiles: readonly MemoryFile[]
  userEnabled: boolean
  meta: MetaStore
  userMeta: MetaStore
  now: number
}>

export type RecallHandler = (query: MemoryRecallQuery, env: RecallEnvironment) => Promise<MemoryRecallResult>

export type CloseHook = () => void | Promise<void>

export interface MemoryPipeline {
  addViewFilter(filter: ViewFilter): void
  addNextExpiry(provider: NextExpiryProvider): void
  addGuard(guard: CommitGuard): void
  addObserver(observer: CommitObserver): void
  setRecall(handler: RecallHandler): void
  addCloseHook(hook: CloseHook): void
  collectHideRanges(entry: MemoryFile, ctx: ViewContext): HideRange[]
  nextExpiry(files: readonly MemoryFile[], ctx: ViewContext): number | undefined
  checkGuards(intent: CommitIntent, ctx: ViewContext): GuardVerdict
  runObservers(intent: CommitIntent, committed: MemoryFile, ctx: ViewContext): void
  readonly recall: RecallHandler | undefined
  close(): Promise<void>
}

export function createPipeline(): MemoryPipeline {
  const filters: ViewFilter[] = []
  const expiryProviders: NextExpiryProvider[] = []
  const guards: CommitGuard[] = []
  const observers: CommitObserver[] = []
  const closeHooks: CloseHook[] = []
  let recallHandler: RecallHandler | undefined

  return {
    addViewFilter(filter) {
      filters.push(filter)
    },
    addNextExpiry(provider) {
      expiryProviders.push(provider)
    },
    addGuard(guard) {
      guards.push(guard)
    },
    addObserver(observer) {
      observers.push(observer)
    },
    setRecall(handler) {
      recallHandler = handler
    },
    addCloseHook(hook) {
      closeHooks.push(hook)
    },
    collectHideRanges(entry, ctx) {
      const ranges: HideRange[] = []
      for (const filter of filters) {
        for (const range of filter(entry, ctx)) ranges.push(range)
      }
      return ranges
    },
    nextExpiry(files, ctx) {
      let earliest: number | undefined
      for (const provider of expiryProviders) {
        const candidate = provider(files, ctx)
        if (candidate !== undefined && (earliest === undefined || candidate < earliest)) {
          earliest = candidate
        }
      }
      return earliest
    },
    checkGuards(intent, ctx) {
      for (const guard of guards) {
        const verdict = guard(intent, ctx)
        if (verdict.kind === 'refuse') return verdict
      }
      return { kind: 'allow' }
    },
    runObservers(intent, committed, ctx) {
      for (const observer of observers) observer(intent, committed, ctx)
    },
    get recall() {
      return recallHandler
    },
    async close() {
      for (const hook of closeHooks) await hook()
    },
  }
}

export { type RetrievalHandle, retrievalOf } from './recall.js'

export function createDefaultPipeline(): MemoryPipeline {
  const pipeline = createPipeline()
  pipeline.addViewFilter((entry, ctx) =>
    ctx.layer === 'workspace' && entry.path === 'MEMORY.md'
      ? managedParagraphRanges(entry.content, ctx.validity).ranges
      : [],
  )
  registerLifecycle(pipeline)
  registerMemoryProtection(pipeline)
  registerRetrieval(pipeline)
  pipeline.addObserver((intent, committed, ctx) => {
    appendAudit(ctx.meta, {
      at: new Date(ctx.now).toISOString(),
      path: intent.path,
      action: 'commit',
      origin: intent.origin,
      actor: intent.actor,
      ...(intent.source?.sessionKey ? { sessionKey: intent.source.sessionKey } : {}),
      ...(intent.source?.maintenance ? { maintenance: intent.source.maintenance } : {}),
      beforeHash: intent.before.hash,
      afterHash: committed.hash,
    })
  })
  return pipeline
}
