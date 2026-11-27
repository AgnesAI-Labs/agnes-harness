import type { MemoryFile, MemoryParagraphValidity, MemorySettings } from '@agnes/extension-api'
import { formatLifecycleOmission } from './consistency.js'
import { file, hash } from './content.js'
import type { MetaStore } from './meta.js'
import type { MemoryPipeline, ViewContext } from './pipeline.js'
import type { MemoryStore } from './store.js'
import { buildView, type HideRange, type MemoryView, retainedEditRanges } from './view.js'

export type TurnReadState = Readonly<{
  files: readonly MemoryFile[]
  own: Map<string, MemoryFile>
  withdrawn: Set<string>
  baseRanges: ReadonlyMap<string, readonly HideRange[]>
  readViews: ReadonlyMap<string, MemoryView>
  agent: ReadonlyMap<string, MemoryFile>
  invalidIndexLimits?: MemorySettings
  revision: string
  validityRev: string | null
  userValidityRev: string | null
  nextExpiry: number | undefined
  userFiles: readonly MemoryFile[]
  userBaseRanges: ReadonlyMap<string, readonly HideRange[]>
  userReadViews: ReadonlyMap<string, MemoryView>
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

// Verify a local commit once before promoting it. Its bytes then stay pinned across foreign overwrites.
function survivingFiles(
  store: MemoryStore,
  entries: readonly MemoryFile[],
  workspace?: Pick<TurnReadState, 'own' | 'withdrawn'>,
): readonly MemoryFile[] {
  const pinned = new Map(entries.map((entry) => [entry.path, entry]))
  const paths = new Set([...pinned.keys(), ...(workspace?.own.keys() ?? [])])
  const files: MemoryFile[] = []
  for (const path of paths) {
    let entry = pinned.get(path)
    if (!entry && workspace?.withdrawn.has(path)) continue
    const own = workspace?.own.get(path)
    const size = store.fileSize(path)
    if (size === undefined) {
      workspace?.withdrawn.add(path)
      continue
    }
    if (own && own !== entry && !workspace?.withdrawn.has(path)) {
      if (store.read(path).hash === own.hash) entry = own
      else if (size === 0) {
        workspace?.withdrawn.add(path)
        entry = file(path, '')
      }
    }
    if (!entry) continue
    if (size === 0 && entry.bytes) {
      workspace?.withdrawn.add(path)
      entry = file(path, '')
    }
    files.push(entry)
  }
  return files.length === entries.length && files.every((entry, i) => entry === entries[i]) ? entries : files
}

function rebuildLayer(
  baseRanges: ReadonlyMap<string, readonly HideRange[]>,
  prevViews: ReadonlyMap<string, MemoryView>,
  ctx: ViewContext,
  pipeline: MemoryPipeline,
  previousFiles?: ReadonlyMap<string, MemoryFile>,
  skipPath?: string,
) {
  const ranges = new Map<string, readonly HideRange[]>()
  const views = new Map<string, MemoryView>()
  const agent = new Map<string, MemoryFile>()
  let changed = false
  for (const entry of ctx.files) {
    const prior = prevViews.get(entry.path)
    // Files excluded from the captured view stay unreadable until the next turn.
    if (!prior && !previousFiles) continue
    if (prior && entry.path === skipPath && entry.bytes) {
      views.set(entry.path, prior)
      agent.set(entry.path, entry)
      continue
    }
    // Retain observed read restrictions, once each. Read notices for topic links reflect the
    // surviving targets, so a removed topic replaces its previous stale-link warning.
    const current = pipeline.collectHideRanges(entry, ctx)
    const retained = entry.bytes
      ? retainedEditRanges(
          previousFiles?.get(entry.path)?.content ?? entry.content,
          entry.content,
          baseRanges.get(entry.path) ?? [],
        )
      : []
    const combined = [...new Map([...retained, ...current].map((r) => [JSON.stringify(r), r])).values()]
    ranges.set(entry.path, combined)
    const rebuilt = buildView(entry, combined, 'read', formatLifecycleOmission)
    views.set(entry.path, rebuilt)
    agent.set(entry.path, rebuilt.content !== entry.content ? file(entry.path, rebuilt.content) : entry)
    if (rebuilt.content !== prior?.content) changed = true
  }
  return { ranges, views, agent, changed }
}

export function nextLayerExpiry(pipeline: MemoryPipeline, workspace: ViewContext, user: ViewContext) {
  const ws = pipeline.nextExpiry(workspace.files, workspace)
  const usr = workspace.userEnabled ? pipeline.nextExpiry(user.files, user) : undefined
  if (ws === undefined) return usr
  return usr === undefined ? ws : Math.min(ws, usr)
}

/** Advance the read view from acknowledged local commits and observed restrictions. */
export function resolveReadOverlay(turn: TurnReadState, live: LiveOverlayInputs): TurnReadState {
  const files = survivingFiles(live.store, turn.files, turn)
  const userFiles = turn.userEnabled ? survivingFiles(live.user, turn.userFiles) : turn.userFiles
  const expiryCrossed = turn.nextExpiry !== undefined && live.now >= turn.nextExpiry
  const filesChanged = files !== turn.files || userFiles !== turn.userFiles
  if (
    !filesChanged &&
    !expiryCrossed &&
    live.validityRev === turn.validityRev &&
    live.userValidityRev === turn.userValidityRev
  )
    return turn

  const wsCtx: ViewContext = {
    layer: 'workspace',
    files,
    userFiles,
    userEnabled: turn.userEnabled,
    now: live.now,
    validity: live.validity,
    meta: live.meta,
  }
  const ws = rebuildLayer(
    turn.baseRanges,
    turn.readViews,
    wsCtx,
    live.pipeline,
    new Map(turn.files.map((entry) => [entry.path, entry])),
    turn.invalidIndexLimits && !turn.own.has('MEMORY.md') ? 'MEMORY.md' : undefined,
  )
  const userCtx: ViewContext = {
    ...wsCtx,
    layer: 'user',
    files: userFiles,
    validity: live.userValidity,
    meta: live.userMeta,
  }
  const usr = rebuildLayer(turn.userBaseRanges, turn.userReadViews, userCtx, live.pipeline)
  const revision =
    filesChanged || ws.changed || usr.changed
      ? hash(
          JSON.stringify([
            turn.revision,
            ...(turn.own.size ? [[...turn.own.values()].map(({ path, hash }) => [path, hash])] : []),
            ...[ws.views, usr.views].map((views) =>
              [...views].map(([path, view]) => [path, hash(view.content)]),
            ),
          ]),
        )
      : turn.revision

  return {
    ...turn,
    files,
    baseRanges: ws.ranges,
    readViews: ws.views,
    agent: ws.agent,
    userFiles,
    userBaseRanges: usr.ranges,
    userReadViews: usr.views,
    validityRev: live.validityRev,
    userValidityRev: live.userValidityRev,
    nextExpiry:
      expiryCrossed || filesChanged ? nextLayerExpiry(live.pipeline, wsCtx, userCtx) : turn.nextExpiry,
    revision,
  }
}
