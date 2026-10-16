import { builtinModelAdapterCatalog } from '@agnes/host'
import type { AdminLoop, AdminModelAdapter } from '@agnes/protocol'
import type { WorkerLink } from './worker-link.js'

type Adapter = Pick<AdminModelAdapter, 'id' | 'capabilities'>

/** How long `apis.list` waits for a running worker to name its adapters before it answers without. */
export const ADAPTER_LOOKUP_WAIT_MS = 2_000

/** What the shared worker's assembled Host reports about sessions, as the supervisor reads it. */
export type SharedSessionCatalog = {
  presets?: readonly { id: string; isDefault: boolean }[]
  loops: AdminLoop[]
  modelAdapters: AdminModelAdapter[]
}

/** The shared worker's session catalog. It starts the worker if none is running. */
export async function sharedSessionCatalog(pool: {
  acquireSharedWorker(): Promise<Pick<WorkerLink, 'command'>>
}): Promise<SharedSessionCatalog> {
  const link = await pool.acquireSharedWorker()
  return (await link.command('session.catalog', {}, { timeoutMs: 31_000 })) as SharedSessionCatalog
}

/**
 * Which model adapters take payloads only, for the supervisor, which holds no adapter registry.
 *
 * It never starts or waits on a worker for the common case: when every declared route uses a
 * built-in registration, the built-in capabilities answer. Only a route of a community adapter makes
 * it ask, and then it asks the shared worker only if that worker is already running, for at most
 * `waitMs`. Otherwise, or if the worker fails or is late, it answers with the last catalog it read
 * (or the built-ins), so `apis.list` is never slower than `waitMs` and never fails; the host gate
 * still refuses a payload-only model whichever list it came from.
 */
export function modelAdapterLookup(o: {
  routes(): readonly Readonly<{ api: string }>[]
  /** The shared worker, only if it is already running. */
  worker(): Pick<WorkerLink, 'command'> | undefined
  waitMs?: number
}): () => Promise<readonly Adapter[]> {
  const waitMs = o.waitMs ?? ADAPTER_LOOKUP_WAIT_MS
  const builtin = builtinModelAdapterCatalog()
  const builtinIds = new Set(builtin.map((adapter) => adapter.id))
  let last: readonly Adapter[] | undefined
  return async () => {
    if (o.routes().every((route) => builtinIds.has(route.api))) return builtin
    const worker = o.worker()
    if (!worker) return last ?? builtin
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const catalog = (await Promise.race([
        worker.command('session.catalog', {}, { timeoutMs: waitMs }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('adapter lookup timed out')), waitMs)
        }),
      ])) as { modelAdapters: readonly Adapter[] }
      last = catalog.modelAdapters
      return last
    } catch {
      return last ?? builtin
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * The supervisor's lookup over its own profile and worker pool. Create it once per daemon, not per
 * connection: the catalog it last read is then shared by every connection.
 */
export function supervisorAdapterLookup(
  host: { profile: { provider: { routes?: readonly Readonly<{ api: string }>[] } } },
  pool: { businessWorker(): { link: Pick<WorkerLink, 'command'> } | undefined },
): ReturnType<typeof modelAdapterLookup> {
  return modelAdapterLookup({
    routes: () => host.profile.provider.routes ?? [],
    worker: () => pool.businessWorker()?.link,
  })
}
