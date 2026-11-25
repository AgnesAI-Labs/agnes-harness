import type { MemoryFile, MemoryParagraphValidity, MemorySettings } from '@agnes/extension-api'
import { formatLifecycleOmission } from './consistency.js'
import { file, hash } from './content.js'
import type { MetaStore } from './meta.js'
import type { MemoryPipeline, ViewContext } from './pipeline.js'
import type { MemoryStore } from './store.js'
import { buildView, type HideRange, type MemoryView } from './view.js'

export type TurnReadState = Readonly<{
  files: readonly MemoryFile[]
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

// Remove only bytes that disappeared. Modified nonempty bodies stay pinned until the next turn.
function survivingFiles(store: MemoryStore, entries: readonly MemoryFile[]): readonly MemoryFile[] {
  const files: MemoryFile[] = []
  let changed = false
  for (const entry of entries) {
    const size = store.fileSize(entry.path)
    if (size === undefined) changed = true
    else if (size === 0 && entry.bytes > 0) {
      files.push(file(entry.path, ''))
      changed = true
    } else files.push(entry)
  }
  return changed ? files : entries
}

function rebuildLayer(
  baseRanges: ReadonlyMap<string, readonly HideRange[]>,
  prevViews: ReadonlyMap<string, MemoryView>,
  ctx: ViewContext,
  pipeline: MemoryPipeline,
  skipPath?: string,
) {
  const ranges = new Map<string, readonly HideRange[]>()
  const views = new Map<string, MemoryView>()
  const agent = new Map<string, MemoryFile>()
  let changed = false
  for (const entry of ctx.files) {
    const prior = prevViews.get(entry.path)
    // Files excluded from the captured view stay unreadable until the next turn.
    if (!prior) continue
    if (entry.path === skipPath && entry.bytes) {
      views.set(entry.path, prior)
      agent.set(entry.path, entry)
      continue
    }
    // Retain observed read restrictions, once each. Read notices for topic links reflect the
    // surviving targets, so a removed topic replaces its previous stale-link warning.
    const current = pipeline.collectHideRanges(entry, ctx)
    const retained = entry.bytes
      ? (baseRanges.get(entry.path) ?? []).filter((r) => r.appliesTo !== 'note')
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

/** Advance the agent read view independently of the original snapshot and whole-file CAS baseline. */
export function resolveReadOverlay(turn: TurnReadState, live: LiveOverlayInputs): TurnReadState {
  const files = survivingFiles(live.store, turn.files)
  const userFiles = turn.userEnabled ? survivingFiles(live.user, turn.userFiles) : turn.userFiles
  const expiryCrossed = turn.nextExpiry !== undefined && live.now >= turn.nextExpiry
  const filesRemoved = files !== turn.files || userFiles !== turn.userFiles
  if (
    !filesRemoved &&
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
    turn.invalidIndexLimits ? 'MEMORY.md' : undefined,
  )
  const usr = rebuildLayer(
    turn.userBaseRanges,
    turn.userReadViews,
    {
      ...wsCtx,
      layer: 'user',
      files: userFiles,
      validity: live.userValidity,
      meta: live.userMeta,
    },
    live.pipeline,
  )
  const revision =
    filesRemoved || ws.changed || usr.changed
      ? hash(
          JSON.stringify([
            turn.revision,
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
    nextExpiry: expiryCrossed ? live.pipeline.nextExpiry(files, wsCtx) : turn.nextExpiry,
    revision,
  }
}
