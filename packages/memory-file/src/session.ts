import { join, relative, resolve } from 'node:path'
import type {
  MemoryFile,
  MemoryFilePort,
  MemoryInspection,
  MemoryParagraphValidity,
  MemorySession,
  MemorySettings,
  MemorySnapshot,
  MemorySource,
  MemoryValidityView,
} from '@agnes/extension-api'
import { chunkView } from './chunker.js'
import { commitHooks } from './commit-hooks.js'
import { buildIndexView, formatLifecycleOmission, inspectConsistency } from './consistency.js'
import { fault, file, fitBytes, hash, validateContent } from './content.js'
import { createFilePort } from './file-port.js'
import { MetaStore } from './meta.js'
import { resolveReadOverlay, type TurnReadState } from './overlay.js'
import { paragraphPort } from './paragraph-port.js'
import { markerLines, validityOf } from './paragraphs.js'
import { canonical, inside, name, roots } from './paths.js'
import {
  createDefaultPipeline,
  type MemoryClock,
  type MemoryPipeline,
  retrievalOf,
  type ViewContext,
} from './pipeline.js'
import { MemoryStore } from './store.js'
import { renderUserLayer, userParagraphPort } from './user-layer.js'
import { buildView, type HideRange, type MemoryView, rawOffsetToLine } from './view.js'

export type OpenMemoryInput = Readonly<{
  home: string
  workspaceRoot: string
  sessionKey: string
  validity?: MemoryValidityView
  userValidity?: MemoryValidityView
  clock?: MemoryClock
  pipeline?: MemoryPipeline
}>

type TurnSnapshot = TurnReadState & {
  snapshot: MemorySnapshot
  readState?: TurnReadState
  noteViewContent: string
}

type SessionInternals = Readonly<{
  store: MemoryStore
  user: MemoryStore
  meta: MetaStore
  pipeline: MemoryPipeline
  clock: MemoryClock
  validity: (id: string) => MemoryParagraphValidity
  capture: (turn: number) => TurnSnapshot
  resolvedFor: (turn: TurnSnapshot) => TurnReadState
}>

const sessions = new WeakMap<MemorySession, SessionInternals>()

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
      const omitted = { ...emptyView(entry.path), hidden: markerLines(entry.content).length > 0 }
      baseRanges.set(entry.path, [])
      readViews.set(entry.path, omitted)
      agent.set(entry.path, entry)
      continue
    }
    const ranges = pipeline.collectHideRanges(entry, ctx)
    const view = buildView(entry, ranges, 'read', formatLifecycleOmission)
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
    indexView = readViews.get('MEMORY.md') ?? emptyView(index.path)
    noteView = indexView
  } else if (readViews.has('MEMORY.md')) {
    indexView = readViews.get('MEMORY.md')!
    const indexRanges = baseRanges.get('MEMORY.md') ?? []
    noteView = buildView(index, indexRanges, 'note', formatLifecycleOmission)
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
      if (entry.path === 'MEMORY.md' && !userValid) continue
      const ranges = pipeline.collectHideRanges(entry, userCtx)
      userBaseRanges.set(entry.path, ranges)
      userReadViews.set(entry.path, buildView(entry, ranges, 'read', formatLifecycleOmission))
    }
  }

  // Consult validity revision lazily so unmanaged files never touch the registry.
  const validityRev = indexManaged || touchedValidity ? viewRevision(validityView) : null
  const userValidityRev = userView.managed || touchedUserValidity ? viewRevision(userValidityView) : null

  const userTopics = userFiles
    .filter((entry) => entry.path !== 'MEMORY.md')
    .map(({ path, hash }) => [path, hash])
  // Without extra filter outputs, revision input stays byte-for-byte identical to the baseline formula.
  const revision = hash(
    JSON.stringify([
      files.map(({ path, hash }) => [path, hash]),
      userIndex.hash,
      ...(userTopics.length ? [{ userTopics }] : []),
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
    ...(indexValid ? {} : { invalidIndexLimits: config }),
    revision,
    validityRev,
    userValidityRev,
    nextExpiry: pipeline.nextExpiry(files, ctx),
    userFiles,
    userBaseRanges,
    userReadViews,
    userEnabled: config.userEnabled,
    noteViewContent: indexValid ? noteView.content : '',
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
  const user = new MemoryStore(paths.protectedRoot, paths.userRoot, 'user')
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
  const resolvedFor = (turn: TurnSnapshot): TurnReadState => {
    const prior = turn.readState ?? turn
    const current = resolveReadOverlay(prior, {
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
    if (current !== prior) turn.readState = current
    return current
  }
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

  const session: MemorySession = Object.freeze<MemorySession>({
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
      value.snapshot = snapshot
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
        commitHooks(
          pipeline,
          { origin: 'human', actor, path: leaf, via: 'edit', layer: 'workspace', source: editSource },
          () => viewCtx(clock()),
        ),
      )
    },
  })
  sessions.set(session, { store, user, meta, pipeline, clock, validity, capture, resolvedFor })
  return session
}

export async function rebuildMemoryIndex(session: MemorySession): Promise<{ indexedEntries: number }> {
  const internal = sessions.get(session)
  const retrieval = internal ? retrievalOf(internal.pipeline) : undefined
  if (!internal || !retrieval) throw fault('MEMORY_RECALL_UNAVAILABLE')
  const { store, user, meta, pipeline, clock, validity } = internal
  const config = store.configuration()
  const files = store.files()
  const userFiles = config.userEnabled ? user.files() : []
  const ctx: ViewContext = {
    layer: 'workspace',
    files,
    userFiles,
    userEnabled: config.userEnabled,
    now: clock(),
    validity,
    meta,
  }
  const views = new Map(
    files.map((entry) => [entry.path, buildIndexView(entry, pipeline.collectHideRanges(entry, ctx))]),
  )
  return { indexedEntries: retrieval.rebuildIndex(meta, files, views, config) }
}

export async function inspectMemoryConsistency(
  session: MemorySession,
  turn: number,
): Promise<{
  consistent: boolean
  noteIds: readonly string[]
  readIds: readonly string[]
  indexIds: readonly string[]
  rawFilteredIds: readonly string[]
  mismatches: readonly string[]
}> {
  const internal = sessions.get(session)
  if (!internal) throw fault('MEMORY_RECALL_UNAVAILABLE')
  const { store, user, meta, pipeline, clock, validity, capture, resolvedFor } = internal
  const snap = capture(turn)
  const state = resolvedFor(snap)
  const config = store.configuration()
  const ctx: ViewContext = {
    layer: 'workspace',
    files: snap.files,
    ...(config.userEnabled ? { userFiles: user.files() } : {}),
    userEnabled: config.userEnabled,
    now: clock(),
    validity,
    meta,
  }
  const retrieval = retrievalOf(pipeline)
  const safeChunks = (entry: MemoryFile, view: MemoryView) => {
    if (!entry.bytes) return []
    try {
      validateContent(entry, config, entry.path === 'MEMORY.md')
      return chunkView(entry, view)
    } catch {
      return []
    }
  }
  const res = await inspectConsistency({
    pipeline,
    context: ctx,
    injectedIndex: snap.noteViewContent,
    readViews: state.readViews,
    ...(retrieval
      ? {
          chunkView: safeChunks,
          readIndexedChunks: () => retrieval.inspectIndexedChunks(meta),
        }
      : {}),
  })
  const keyOf = (chunk: { path: string; lineStart: number; lineEnd: number; text: string }) =>
    `${chunk.path}:${chunk.lineStart}-${chunk.lineEnd}:${hash(chunk.text)}`
  const readIds = state.files.flatMap((entry) => {
    const view = state.readViews.get(entry.path)
    return view ? safeChunks(entry, view).map(keyOf) : []
  })
  const rawFilteredIds = snap.files.flatMap((entry) =>
    safeChunks(entry, buildIndexView(entry, pipeline.collectHideRanges(entry, ctx))).map(keyOf),
  )
  const indexIds = retrieval ? retrieval.inspectIndexedChunks(meta).map(keyOf) : []
  const noteIds = snap.noteViewContent
    ? snap.noteViewContent
        .split('\n')
        .filter(Boolean)
        .map((line) => hash(line))
    : []
  return {
    consistent: res.ok,
    noteIds,
    readIds,
    indexIds,
    rawFilteredIds,
    mismatches: res.mismatches,
  }
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
