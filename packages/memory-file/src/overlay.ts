import type { MemoryFile, MemoryParagraphValidity } from '@agnes/extension-api'
import { formatLifecycleOmission } from './consistency.js'
import { file, hash } from './content.js'
import type { MetaStore } from './meta.js'
import type { MemoryPipeline, ViewContext } from './pipeline.js'
import type { MemoryStore } from './store.js'
import { buildView, type HideRange, type MemoryView } from './view.js'

export type TurnOverlayInput = Readonly<{
  files: readonly MemoryFile[]
  baseRanges: ReadonlyMap<string, readonly HideRange[]>
  readViews: ReadonlyMap<string, MemoryView>
  agent: ReadonlyMap<string, MemoryFile>
  indexValid: boolean
  snapshotRevision: string
  validityRev: string | null
  userValidityRev: string | null
  nextExpiry: number | undefined
  userFiles: readonly MemoryFile[]
  userBaseRanges: ReadonlyMap<string, readonly HideRange[]>
  userReadViews: ReadonlyMap<string, MemoryView>
  userEnabled: boolean
}>

export type ResolvedReadState = Readonly<{
  active: boolean
  revision: string
  files: readonly MemoryFile[]
  views: ReadonlyMap<string, MemoryView>
  agent: ReadonlyMap<string, MemoryFile>
  deleted: ReadonlySet<string>
  emptied: ReadonlySet<string>
  userFiles: readonly MemoryFile[]
  userViews: ReadonlyMap<string, MemoryView>
  userEnabled: boolean
}>

type LiveOverlayInputs = Readonly<{
  store: MemoryStore
  user: MemoryStore
  meta: MetaStore
  userMeta: MetaStore
  pipeline: MemoryPipeline
  validity: (id: string) => MemoryParagraphValidity
  userValidity: (id: string) => MemoryParagraphValidity
  validityRev: string | null
  userValidityRev: string | null
  now: number
}>

function scanRemovals(store: MemoryStore, entries: readonly MemoryFile[]) {
  const deleted = new Set<string>()
  const emptied = new Set<string>()
  for (const entry of entries) {
    const size = store.fileSize(entry.path)
    if (size === undefined) deleted.add(entry.path)
    else if (size === 0 && entry.bytes > 0) emptied.add(entry.path)
  }
  return { deleted, emptied }
}

function emptyViewFor(path: string): MemoryView {
  return {
    path,
    content: '',
    segments: [{ view: 0, raw: 0, length: 0 }],
    hidden: false,
    omitted: [],
  }
}

function rebuildLayer(
  entries: readonly MemoryFile[],
  baseRanges: ReadonlyMap<string, readonly HideRange[]>,
  prevViews: ReadonlyMap<string, MemoryView>,
  removals: { deleted: Set<string>; emptied: Set<string> },
  ctx: ViewContext,
  pipeline: MemoryPipeline,
  skipPath?: string,
) {
  const files: MemoryFile[] = []
  const views = new Map<string, MemoryView>()
  const agent = new Map<string, MemoryFile>()
  let changed = removals.deleted.size > 0 || removals.emptied.size > 0
  for (const entry of entries) {
    if (removals.deleted.has(entry.path)) continue
    if (removals.emptied.has(entry.path)) {
      const empty = file(entry.path, '')
      files.push(empty)
      agent.set(entry.path, empty)
      views.set(entry.path, emptyViewFor(entry.path))
      continue
    }
    files.push(entry)
    if (entry.path === skipPath) {
      const kept = prevViews.get(entry.path)
      if (kept) views.set(entry.path, kept)
      agent.set(entry.path, entry)
      continue
    }
    const prior = prevViews.get(entry.path)
    const combined = [...(baseRanges.get(entry.path) ?? []), ...pipeline.collectHideRanges(entry, ctx)]
    const rebuilt = buildView(entry, combined, 'read', formatLifecycleOmission)
    views.set(entry.path, rebuilt)
    agent.set(entry.path, rebuilt.content !== entry.content ? file(entry.path, rebuilt.content) : entry)
    if (rebuilt.content !== (prior?.content ?? entry.content)) changed = true
  }
  return { files, views, agent, changed }
}

/**
 * R2 / R5 same-turn monotonic removal overlay. Does NOT mutate `turnSnapshot` and does NOT read
 * modified non-empty disk bodies so same-turn writes still detect CAS conflicts against the snapshot.
 */
export function resolveReadOverlay(turn: TurnOverlayInput, live: LiveOverlayInputs): ResolvedReadState {
  const wsRemovals = scanRemovals(live.store, turn.files)
  const userRemovals = turn.userEnabled
    ? scanRemovals(live.user, turn.userFiles)
    : { deleted: new Set<string>(), emptied: new Set<string>() }
  const validityChanged = live.validityRev !== turn.validityRev
  const userValidityChanged = live.userValidityRev !== turn.userValidityRev
  const expiryCrossed = turn.nextExpiry !== undefined && live.now >= turn.nextExpiry
  const filesRemoved =
    wsRemovals.deleted.size > 0 ||
    wsRemovals.emptied.size > 0 ||
    userRemovals.deleted.size > 0 ||
    userRemovals.emptied.size > 0

  if (!validityChanged && !userValidityChanged && !expiryCrossed && !filesRemoved) {
    return {
      active: false,
      revision: turn.snapshotRevision,
      files: turn.files,
      views: turn.readViews,
      agent: turn.agent,
      deleted: wsRemovals.deleted,
      emptied: wsRemovals.emptied,
      userFiles: turn.userFiles,
      userViews: turn.userReadViews,
      userEnabled: turn.userEnabled,
    }
  }

  const wsCtx: ViewContext = {
    layer: 'workspace',
    files: turn.files,
    userFiles: turn.userFiles,
    userEnabled: turn.userEnabled,
    now: live.now,
    validity: live.validity,
    meta: live.meta,
  }
  const ws = rebuildLayer(
    turn.files,
    turn.baseRanges,
    turn.readViews,
    wsRemovals,
    wsCtx,
    live.pipeline,
    turn.indexValid ? undefined : 'MEMORY.md',
  )
  const userCtx: ViewContext = {
    layer: 'user',
    files: turn.userFiles,
    userFiles: turn.userFiles,
    userEnabled: turn.userEnabled,
    now: live.now,
    validity: live.userValidity,
    meta: live.userMeta,
  }
  const usr = turn.userEnabled
    ? rebuildLayer(
        turn.userFiles,
        turn.userBaseRanges,
        turn.userReadViews,
        userRemovals,
        userCtx,
        live.pipeline,
      )
    : { files: turn.userFiles, views: turn.userReadViews, changed: false }

  const active = ws.changed || usr.changed
  const revision = active
    ? hash(
        JSON.stringify([
          turn.snapshotRevision,
          [...wsRemovals.deleted].sort(),
          [...wsRemovals.emptied].sort(),
          [...ws.views.entries()].map(([p, v]) => [p, hash(v.content)]),
          [...usr.views.entries()].map(([p, v]) => [p, hash(v.content)]),
        ]),
      )
    : turn.snapshotRevision

  return {
    active,
    revision,
    files: ws.files,
    views: ws.views,
    agent: ws.agent,
    deleted: wsRemovals.deleted,
    emptied: wsRemovals.emptied,
    userFiles: usr.files,
    userViews: usr.views,
    userEnabled: turn.userEnabled,
  }
}
