import type { PackageListResult } from '@agnes/protocol'
import type { PluginAdminApi } from '../api.js'
import type { AdminContext, AdminPageState } from '../types.js'
import { readBundledCatalog } from './model.js'

type Inventory = Pick<AdminPageState, 'context' | 'installed' | 'generations' | 'surfaceLinks' | 'tree'>

/** The last inventory this page session read, so coming back shows it at once while it is read again. */
let last: Inventory | undefined

/** Keep what a successful read returned; the state is handed back unchanged. */
export function rememberInventory(state: AdminPageState): AdminPageState {
  const { context, installed, generations, surfaceLinks, tree } = state
  last = { context, installed, generations, surfaceLinks, tree }
  return state
}

/**
 * The state a new controller starts from: the remembered inventory, shown as connected but still
 * loading (it is not authoritative until the new read lands), or the empty first state.
 */
export function seededState(state: AdminPageState): AdminPageState {
  return last ? { ...state, ...last, connection: 'connected', loading: true } : state
}

/** Forget the remembered inventory (tests). */
export function forgetInventory(): void {
  last = undefined
  invalidateInventory()
}

/** A short display freshness window; authorization is always read separately. */
export const INVENTORY_FRESH_MS = 30_000
let revision = 0
let fresh: { key: string; expires: number; snapshot: Awaited<ReturnType<typeof fetchInventory>> } | undefined
let stopWatching: (() => void) | undefined

function invalidateInventory() {
  revision++
  fresh = undefined
  stopWatching?.()
  stopWatching = undefined
}

async function fetchInventory(api: PluginAdminApi, verifiedList?: PackageListResult) {
  const [list, surfaceFeed, tree, bundledCatalog] = await Promise.all([
    verifiedList ?? api.list(),
    api.surfaceLinks().catch(() => undefined),
    api.treeList().catch(() => undefined),
    readBundledCatalog(api).catch(() => []),
  ])
  // These catalogs only describe presentation. A slow Host must not block a verified inventory.
  const presentation = Promise.all([
    api.runtime().catch(() => undefined),
    api.composition().catch(() => undefined),
  ]).then(([runtimeCatalog, composition]) => ({ runtimeCatalog, composition }))
  return { list, surfaceFeed, tree, presentation, bundledCatalog }
}

/** The caller supplies a newly read context, never a remembered permission decision. */
export async function readInventorySnapshot(
  api: PluginAdminApi,
  context: AdminContext,
  reuse: boolean,
  verifiedList?: PackageListResult,
) {
  const key = JSON.stringify(context)
  if (reuse && fresh?.key === key && Date.now() < fresh.expires)
    return verifiedList ? { ...fresh.snapshot, list: verifiedList } : fresh.snapshot
  invalidateInventory()
  const requested = revision
  const expires = Date.now() + INVENTORY_FRESH_MS
  // Keep invalidation alive across page unmounts, but only for the lifetime of this cache entry.
  const events = ['agnes:plugins-invalidated', 'online']
  for (const event of events) window.addEventListener(event, invalidateInventory)
  const timer = setTimeout(invalidateInventory, INVENTORY_FRESH_MS)
  stopWatching = () => {
    clearTimeout(timer)
    for (const event of events) window.removeEventListener(event, invalidateInventory)
  }
  try {
    const snapshot = await fetchInventory(api, verifiedList)
    if (requested === revision) fresh = { key, expires, snapshot }
    return snapshot
  } catch (error) {
    if (requested === revision) invalidateInventory()
    throw error
  }
}
