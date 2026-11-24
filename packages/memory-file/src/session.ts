import { join, relative, resolve } from 'node:path'
import type {
  MemoryApprovalResult,
  MemoryEffectAdmission,
  MemoryFile,
  MemoryFilePort,
  MemoryInspection,
  MemoryProposal,
  MemorySession,
  MemorySettings,
  MemorySnapshot,
  MemorySource,
  MemoryValidityView,
} from '@agnes/extension-api'
import { appendAudit } from './audit.js'
import { diff, fault, file, fitBytes, hash, omissionLine, validateContent } from './content.js'
import { MetaStore } from './meta.js'
import { type ResolvedReadState, resolveReadOverlay, type TurnOverlayInput } from './overlay.js'
import { paragraphPort } from './paragraph-port.js'
import {
  markerLines,
  markerSet,
  paragraphTexts,
  parseParagraphs,
  unfilteredIndexView,
  validityOf,
} from './paragraphs.js'
import { canonical, inside, name, roots } from './paths.js'
import {
  type CommitIntent,
  createDefaultPipeline,
  type MemoryClock,
  type MemoryPipeline,
  type ViewContext,
} from './pipeline.js'
import { MemoryStore } from './store.js'
import { renderUserLayer, userParagraphPort } from './user-layer.js'
import { buildView, type HideRange, type MemoryView, rawOffsetToLine, replaceInMemoryView } from './view.js'

export type OpenMemoryInput = Readonly<{
  home: string
  workspaceRoot: string
  sessionKey: string
  validity?: MemoryValidityView
  userValidity?: MemoryValidityView
  clock?: MemoryClock
  pipeline?: MemoryPipeline
}>

type TurnSnapshot = TurnOverlayInput & {
  snapshot: MemorySnapshot
}

const formatMerged = (group: string, count: number) => (group === 'managed' ? omissionLine(count) : '')

function holding<T extends { length: number }>(
  segments: readonly T[],
  at: (segment: T) => number | undefined,
  offset: number,
) {
  const of = (end: boolean) =>
    segments.find((segment) => {
      const start = at(segment)
      return (
        start !== undefined &&
        start <= offset &&
        (end ? offset <= start + segment.length : offset < start + segment.length)
      )
    })
  return of(false) ?? of(true)
}

function readLineFor(
  indexValid: boolean,
  workspaceContent: string,
  noteView: MemoryView,
  readView: MemoryView,
  offset: number,
): number {
  if (!indexValid) return workspaceContent.slice(0, offset).split('\n').length
  const from = holding(
    noteView.segments,
    (segment) => (segment.raw === undefined ? undefined : segment.view),
    offset,
  )
  const raw = from?.raw === undefined ? undefined : from.raw + (offset - from.view)
  const to = raw === undefined ? undefined : holding(readView.segments, (segment) => segment.raw, raw)
  const read = to?.raw === undefined || raw === undefined ? offset : to.view + (raw - to.raw)
  return rawOffsetToLine(readView.content, read)
}

function buildUnfilteredView(content: string): MemoryView {
  const legacy = unfilteredIndexView(content)
  return {
    path: 'MEMORY.md',
    content: legacy.content,
    segments: legacy.segments,
    hidden: legacy.hidden,
    omitted: legacy.omittedIds,
  }
}

function emptyView(path: string): MemoryView {
  return {
    path,
    content: '',
    segments: [{ view: 0, raw: 0, length: 0 }],
    hidden: false,
    omitted: [],
  }
}

function captureTurnSnapshot(args: {
  root: string
  store: MemoryStore
  user: MemoryStore
  meta: MetaStore
  userMeta: MetaStore
  pipeline: MemoryPipeline
  validityView: MemoryValidityView | undefined
  userValidityView: MemoryValidityView | undefined
  clock: MemoryClock
}): TurnSnapshot {
  const { root, store, user, meta, userMeta, pipeline, validityView, userValidityView, clock } = args
  const validity = validityOf(validityView)
  const userValidity = validityOf(userValidityView)
  const config = store.configuration()
  const files = store.files()
  const now = clock()
  let touchedValidity = false
  const trackedValidity = (id: string) => {
    touchedValidity = true
    return validity(id)
  }
  const userIndex = config.userEnabled ? user.read('MEMORY.md') : file('MEMORY.md', '')
  const userValid = passes(userIndex, config)
  const userFiles = config.userEnabled
    ? pipeline.recall
      ? user.files()
      : userIndex.bytes > 0
        ? [userIndex]
        : []
    : []
  const ctx: ViewContext = {
    layer: 'workspace',
    files,
    userFiles,
    userEnabled: config.userEnabled,
    now,
    validity: trackedValidity,
    meta,
  }
  const index = files.find((entry) => entry.path === 'MEMORY.md') ?? file('MEMORY.md', '')
  const indexValid = passes(index, config)
  const baseRanges = new Map<string, HideRange[]>()
  const readViews = new Map<string, MemoryView>()
  const agent = new Map<string, MemoryFile>()
  const nonManagedDiffs: [string, string][] = []

  for (const entry of files) {
    if (entry.path === 'MEMORY.md' && !indexValid) {
      const unfiltered = buildUnfilteredView(entry.content)
      baseRanges.set(entry.path, [])
      readViews.set(entry.path, unfiltered)
      agent.set(entry.path, entry)
      continue
    }
    const ranges = pipeline.collectHideRanges(entry, ctx)
    const view = buildView(entry, ranges, 'read', formatMerged)
    baseRanges.set(entry.path, ranges)
    readViews.set(entry.path, view)
    agent.set(entry.path, view.content !== entry.content ? file(entry.path, view.content) : entry)
    if (ranges.some((range) => range.reason !== 'managed-omitted' && range.reason !== 'managed-delivered')) {
      nonManagedDiffs.push([entry.path, hash(view.content)])
    }
  }

  let indexView: MemoryView
  let noteView: MemoryView
  if (!indexValid) {
    indexView = readViews.get('MEMORY.md') ?? buildUnfilteredView(index.content)
    noteView = indexView
  } else if (readViews.has('MEMORY.md')) {
    indexView = readViews.get('MEMORY.md')!
    const indexRanges = baseRanges.get('MEMORY.md') ?? []
    noteView = buildView(index, indexRanges, 'note', formatMerged)
    if (noteView.content !== indexView.content) {
      const hasExtra = indexRanges.some(
        (range) => range.reason !== 'managed-omitted' && range.reason !== 'managed-delivered',
      )
      if (hasExtra) nonManagedDiffs.push(['MEMORY.md:note', hash(noteView.content)])
    }
  } else {
    const empty = emptyView('MEMORY.md')
    indexView = empty
    noteView = empty
  }

  const indexManaged = markerLines(index.content).length > 0
  const userView = renderUserLayer(userValid ? userIndex.content : '', userValidityView)
  const userBaseRanges = new Map<string, HideRange[]>()
  const userReadViews = new Map<string, MemoryView>()
  let touchedUserValidity = false
  if (config.userEnabled) {
    const userCtx: ViewContext = {
      layer: 'user',
      files: userFiles,
      userFiles,
      userEnabled: true,
      now,
      validity: (id) => {
        touchedUserValidity = true
        return userValidity(id)
      },
      meta: userMeta,
    }
    for (const entry of userFiles) {
      const ranges = pipeline.collectHideRanges(entry, userCtx)
      userBaseRanges.set(entry.path, ranges)
      userReadViews.set(entry.path, buildView(entry, ranges, 'read', formatMerged))
    }
  }

  // Consult validity revision lazily so unmanaged files never touch the registry.
  const validityRev = indexManaged || touchedValidity ? viewRevision(validityView) : null
  const userValidityRev = userView.managed || touchedUserValidity ? viewRevision(userValidityView) : null

  // Without extra filter outputs, revision input stays byte-for-byte identical to the baseline formula.
  const revision = hash(
    JSON.stringify([
      files.map(({ path, hash }) => [path, hash]),
      userIndex.hash,
      ...(indexManaged ? [indexView.omitted, validityRev] : []),
      ...(userView.managed ? [{ user: [userView.omittedIds, userValidityRev] }] : []),
      ...(nonManagedDiffs.length ? [nonManagedDiffs] : []),
    ]),
  )
  const workspaceContent = indexValid
    ? noteView.content
    : '[Memory omitted: consolidate the index or remove secret-like content.]'
  const userContent = userValid
    ? userView.text
    : '[User memory omitted: consolidate the index or remove secret-like content.]'
  const workspace = fitBytes(
    workspaceContent,
    config.tokenBudget,
    ({ paragraphs, kb, offset }) =>
      `[Memory truncated at the size limit: ${paragraphs} more ${paragraphs === 1 ? 'paragraph' : 'paragraphs'} (about ${kb} KB) not shown, from line ${readLineFor(indexValid, workspaceContent, noteView, indexView, offset)} of ${join(root, 'MEMORY.md')}. Read them with the read tool when they may matter.]`,
  )
  const userLayer = fitBytes(
    userContent,
    config.userTokenBudget,
    ({ paragraphs, kb }) =>
      `[User memory truncated at the size limit: ${paragraphs} more ${paragraphs === 1 ? 'paragraph' : 'paragraphs'} (about ${kb} KB) not shown.]`,
    '[User memory truncated at the size limit.]',
  )
  const content = [
    `Agent memory (untrusted learned preferences; AGENTS.md and knowledge sources take precedence). Revision: ${revision}.`,
    `Workspace memory directory: ${root}. Use normal read/write/edit tools; topic reads share this turn's revision.`,
    `Policy: ${config.mode}. Consolidate rather than append; never save secrets, one-off details, history or knowledge-base content.`,
    workspace.content,
    ...(config.userEnabled && userContent
      ? [`User memory (read-only for the agent):\n${userLayer.content}`]
      : []),
  ].join('\n\n')

  return {
    files,
    baseRanges,
    readViews,
    agent,
    indexValid,
    snapshotRevision: revision,
    validityRev,
    userValidityRev,
    nextExpiry: pipeline.nextExpiry(files, ctx),
    userFiles,
    userBaseRanges,
    userReadViews,
    userEnabled: config.userEnabled,
    snapshot: Object.freeze({
      revision,
      content,
      omitted: workspace.omitted || userLayer.omitted,
    }),
  }
}

export function openMemory(input: OpenMemoryInput): MemorySession {
  const paths = roots(input.home, input.workspaceRoot)
  const store = new MemoryStore(paths.protectedRoot, paths.root)
  const user = new MemoryStore(paths.protectedRoot, paths.userRoot)
  const meta = new MetaStore(store)
  const userMeta = new MetaStore(user)
  const clock = input.clock ?? Date.now
  const pipeline = input.pipeline ?? createDefaultPipeline()
  const validity = validityOf(input.validity)
  const userValidity = validityOf(input.userValidity)
  let turnSnapshot: { turn: number; value: TurnSnapshot } | undefined

  const capture = (turn: number): TurnSnapshot => {
    if (turnSnapshot?.turn === turn) return turnSnapshot.value
    const value = captureTurnSnapshot({
      root: paths.root,
      store,
      user,
      meta,
      userMeta,
      pipeline,
      validityView: input.validity,
      userValidityView: input.userValidity,
      clock,
    })
    turnSnapshot = { turn, value }
    return value
  }
  const resolvedFor = (turn: TurnSnapshot): ResolvedReadState =>
    resolveReadOverlay(turn, {
      store,
      user,
      meta,
      userMeta,
      pipeline,
      validity,
      userValidity,
      validityRev: turn.validityRev === null ? null : viewRevision(input.validity),
      userValidityRev: turn.userValidityRev === null ? null : viewRevision(input.userValidity),
      now: clock(),
    })
  const target = (path: string): string | undefined => {
    const absolute = resolve(input.workspaceRoot, path)
    const real = canonical(absolute)
    if (!inside(paths.protectedRoot, absolute) && !inside(paths.protectedRoot, real)) return undefined
    if (!inside(paths.root, real) || !inside(paths.root, absolute)) throw fault('MEMORY_SCOPE_DENIED')
    return name(relative(paths.root, real))
  }
  const active = (): MemorySettings & { mode: 'ask' | 'auto' } => {
    const config = store.configuration()
    if (config.mode === 'off') throw fault('MEMORY_DISABLED')
    return config as MemorySettings & { mode: 'ask' | 'auto' }
  }
  const inspect = async (): Promise<MemoryInspection> => {
    const files = store.files().map(({ content: _, ...entry }) => entry)
    const writer = store.writer()
    return {
      root: paths.root,
      settings: store.configuration(),
      files,
      bytes: files.reduce((n, entry) => n + entry.bytes, 0),
      ...(writer ? { lastWriter: writer } : {}),
    }
  }
  const viewCtx = (now: number, config = store.configuration()): ViewContext => ({
    layer: 'workspace',
    files: store.files(),
    ...(config.userEnabled ? { userFiles: user.files() } : {}),
    userEnabled: config.userEnabled,
    now,
    validity,
    meta,
  })

  return Object.freeze<MemorySession>({
    root: paths.root,
    async close() {
      await pipeline.close()
    },
    async snapshot(turn) {
      if (store.configuration().mode === 'off') return undefined
      if (turnSnapshot?.turn === turn) return turnSnapshot.value.snapshot
      const value = capture(turn)
      const externalChanges = await store.externalChanges(value.files)
      if (!externalChanges.length) return value.snapshot
      const snapshot = Object.freeze({ ...value.snapshot, externalChanges: Object.freeze(externalChanges) })
      turnSnapshot = { turn, value: { ...value, snapshot } }
      return snapshot
    },
    files(fallback, source, signal, approve): MemoryFilePort {
      return createFilePort({
        fallback,
        source,
        signal,
        approve,
        workspaceRoot: input.workspaceRoot,
        paths,
        store,
        user,
        meta,
        userMeta,
        pipeline,
        clock,
        validity,
        capture,
        resolvedFor,
        target,
        active,
        viewCtx,
      })
    },
    inspect,
    async configure(config) {
      await store.configure(config)
      return inspect()
    },
    async readFile(path) {
      return store.read(name(path))
    },
    paragraphs(source, signal) {
      return paragraphPort(store, paths.root, input.validity, source, signal, {
        pipeline,
        meta,
        user,
        ...(input.userValidity !== undefined ? { userValidity: input.userValidity } : {}),
        clock,
      })
    },
    userParagraphs(source, signal) {
      return userParagraphPort(user, store, input.userValidity, source, signal, {
        pipeline,
        userMeta,
        clock,
      })
    },
    async editFile(path, content, baseHash, options) {
      const leaf = name(path)
      const actor = options?.actor?.trim() || 'human'
      const editSource: MemorySource = { sessionKey: input.sessionKey, turn: 0 }
      return store.commit(
        file(leaf, content),
        baseHash,
        editSource,
        false,
        undefined,
        undefined,
        (before, saved) => {
          pipeline.runObservers(
            {
              origin: 'human',
              actor,
              path: leaf,
              before,
              candidate: saved,
              via: 'edit',
              layer: 'workspace',
              source: editSource,
            },
            saved,
            viewCtx(clock()),
          )
        },
      )
    },
  })
}

function createFilePort(deps: {
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
  validity: (id: string) => ReturnType<typeof validityOf> extends (id: string) => infer R ? R : never
  capture: (turn: number) => TurnSnapshot
  resolvedFor: (turn: TurnSnapshot) => ResolvedReadState
  target: (path: string) => string | undefined
  active: () => MemorySettings & { mode: 'ask' | 'auto' }
  viewCtx: (now: number, config?: MemorySettings) => ViewContext
}): MemoryFilePort {
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
      const view = buildView(before, ranges, 'read', formatMerged)
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

function passes(entry: MemoryFile, config: MemorySettings): boolean {
  try {
    validateContent(entry, config, true)
    return true
  } catch {
    return false
  }
}

function viewRevision(view: MemoryValidityView | undefined): string | null {
  if (!view) return null
  try {
    return String(view.revision())
  } catch {
    return 'unavailable'
  }
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
  const verdict = pipeline.checkGuards(intent, viewCtx(guardNow, config))
  if (verdict.kind === 'refuse') {
    try {
      appendAudit(meta, {
        at: new Date(guardNow).toISOString(),
        path: leaf,
        action: 'refused',
        code: verdict.code,
        origin: intent.origin,
        actor: intent.actor,
        sessionKey: source.sessionKey,
        beforeHash: before.hash,
        afterHash: candidate.hash,
      })
    } catch {
      // Best-effort refusal audit must not mask guard error.
    }
    throw Object.assign(
      fault(verdict.code),
      verdict.detail ? { message: `${verdict.code}: ${verdict.detail}` } : {},
    )
  }
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
