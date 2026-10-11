import { createMountProxy, type MountProxyMatch, matchMount } from '@agnes/daemon'
import { createClient, memoryJournal } from '@agnes/sdk'
import { localPipeFactories } from '../src/boot/pipe-factory.js'
import type { LocalBackend } from './backend.js'

type MountProxyLookup = Parameters<typeof createMountProxy>[0]['lookup']

/** The least time between two on-demand re-reads of the mount table, so a burst of failed proxy
 *  requests or of lookups while the daemon is down asks the daemon at most once per window. */
export const SURFACE_MOUNT_RETRY_MS = 2_000

/** Reserved URL prefixes the Web server answers with its own fixed branches (design WC3): the admin
 *  surfaces, the skin asset route and the client module asset route. A Surface mount at or under one
 *  of these could never receive traffic anyway (every fixed branch returns before mountProxy is
 *  consulted), so the rows are dropped from the fetched table instead of being proxied -- this turns
 *  what used to be a comment convention in `packages/web-server/src/server.ts` into an enforced rule. */
const RESERVED_MOUNT_PREFIXES = ['/plugins', '/admin', '/skins'] as const

/** True when a Surface mount prefix collides with a reserved Web server namespace. */
export function isReservedMount(mount: string): boolean {
  return RESERVED_MOUNT_PREFIXES.some((prefix) => mount === prefix || mount.startsWith(`${prefix}/`))
}

export type SurfaceMountFeed = Readonly<{
  lookup: MountProxyLookup
  /** Asks for one re-read of the table. Ignored while a read is in flight, within
   *  `SURFACE_MOUNT_RETRY_MS` of the last one, or after close(). */
  refresh(): void
  /** Stops further reads and waits for one in flight. Idempotent. */
  close(): Promise<void>
}>

/**
 * Bridges `createMountProxy`'s synchronous lookup() across the OS-process boundary between `agnesd`
 * and `agh serve` (see packages/daemon/src/local/methods/surfaces.ts for the RPC method this calls).
 *
 * The table is read once at start, over a short-lived private Unix connection identical in kind to
 * `localPackageAdmin`'s (same `auth: {kind:'local'}`, same pipe-factory seam for the Windows named
 * pipe transport). It is not polled. When the daemon restarts or replaces a Surface instance, the old
 * port stops answering, and the first proxied request that cannot reach it asks for a re-read
 * (`refresh`); so does a lookup while no table has been read yet (the daemon was not up at start).
 * Re-reads run one at a time and at most once per `SURFACE_MOUNT_RETRY_MS`. A mount added while this
 * process runs is not seen until a re-read happens or the process restarts.
 *
 * Fails soft in both directions: an unreachable daemon or a query error on the very first read leaves
 * the lookup answering "no mount" for every path, the same degraded-but-serving behavior
 * `boot-coordination.ts`'s `coordinateSurfacesOnBoot` has when no deploy directory was ever trusted.
 * A LATER read failing (after at least one success) keeps serving the last known-good table rather
 * than blanking out a page the user is currently viewing. Web itself remains reachable either way.
 */
export async function fetchSurfaceMountLookup(
  backend: LocalBackend,
  options: Readonly<{ retryMs?: number }> = {},
): Promise<SurfaceMountFeed> {
  // `undefined` means "no successful read has ever landed" -- distinct from "the daemon reports an
  // empty table". Only a SUCCESSFUL read ever writes here.
  let mounts: readonly MountProxyMatch[] | undefined
  let inflight: Promise<void> | undefined
  let lastStart = Number.NEGATIVE_INFINITY
  let stopped = false
  const retryMs = options.retryMs ?? SURFACE_MOUNT_RETRY_MS

  const read = async (): Promise<void> => {
    // A fresh connection and a fresh `memoryJournal` per read. `memoryJournal` is a pure in-memory
    // closure with no shared registry (packages/sdk/src/journal.ts), so calling it repeatedly with
    // the same label is safe.
    const client = createClient({
      transport: { kind: 'unix', path: backend.socketPath },
      transportFactories: localPipeFactories(backend.socketPath, backend.scope),
      auth: { kind: 'local' },
      journal: memoryJournal(`surface-mounts-${backend.scope.scopeID}`),
    })
    try {
      await client.initialize()
      const next = await client.surfaces.mounts()
      if (!stopped) mounts = next.mounts.filter((row) => !isReservedMount(row.mount))
    } finally {
      await client.close().catch(() => undefined)
    }
  }
  const start = (): Promise<void> => {
    lastStart = Date.now()
    const current = read()
      .catch((error: unknown) => {
        console.error(
          mounts === undefined
            ? 'agh serve: could not read the Surface mount table; Surfaces will not be reachable'
            : 'agh serve: Surface mount table refresh failed; serving the last known table',
          error,
        )
      })
      .finally(() => {
        if (inflight === current) inflight = undefined
      })
    inflight = current
    return current
  }
  const refresh = (): void => {
    if (stopped || inflight || Date.now() - lastStart < retryMs) return
    void start()
  }

  await start()
  return Object.freeze({
    // The match predicate itself comes from the shared `matchMount` instead of being re-derived here.
    lookup: (pathname: string) => {
      if (mounts !== undefined) return matchMount(mounts, pathname)
      refresh()
      return undefined
    },
    refresh,
    async close() {
      if (stopped) return
      stopped = true
      await inflight?.catch(() => undefined)
    },
  })
}

/** Convenience wrapper: `fetchSurfaceMountLookup` plus wiring the result into `createMountProxy`. */
export async function fetchSurfaceMountProxy(
  backend: LocalBackend,
  options: Readonly<{ retryMs?: number }> = {},
): Promise<Readonly<{ proxy: ReturnType<typeof createMountProxy>; close(): Promise<void> }>> {
  const feed = await fetchSurfaceMountLookup(backend, options)
  return Object.freeze({
    proxy: createMountProxy({ lookup: feed.lookup, onUnreachable: () => feed.refresh() }),
    close: feed.close,
  })
}
