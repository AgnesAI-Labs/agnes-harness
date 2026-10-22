import { createMountProxy, type MountProxyMatch, matchMount } from '@agnes/daemon'
import { createClient, memoryJournal } from '@agnes/sdk'
import { localPipeFactories } from '../src/boot/pipe-factory.js'
import type { LocalBackend } from './backend.js'

type MountProxyLookup = Parameters<typeof createMountProxy>[0]['lookup']

/** Retry only after a failed read; healthy connections have no periodic mount queries. */
export const SURFACE_MOUNT_REFRESH_MS = 8_000

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
  /** False until a query has succeeded, including after an initial failure. */
  ready(): boolean
  /** Stops subscriptions, retries and the connection. Idempotent; safe to call before the first fetch resolved. */
  close(): Promise<void>
}>

/** Subscribe before reading. Notices are hints; only the authenticated RPC can publish routes.
 * Reconnects re-read the full table. Failed reads retain the last good table and retry serially. */
export async function fetchSurfaceMountLookup(
  backend: LocalBackend,
  options: Readonly<{ intervalMs?: number }> = {},
): Promise<SurfaceMountFeed> {
  let mounts: readonly MountProxyMatch[] | undefined
  let inflight: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let dirty = false
  let terminal = false
  const openClient = () =>
    createClient({
      transport: { kind: 'unix', path: backend.socketPath },
      transportFactories:
        backend.link?.transportFactories() ?? localPipeFactories(backend.socketPath, backend.scope),
      auth: { kind: 'local' },
      journal: memoryJournal(`surface-mounts-${backend.scope.scopeID}`),
    })
  let client = openClient()
  let subscriptions: (() => void)[] = []
  const scheduleRetry = () => {
    if (stopped || retry) return
    retry = setTimeout(() => {
      retry = undefined
      refresh()
    }, options.intervalMs ?? SURFACE_MOUNT_REFRESH_MS)
    retry.unref?.()
  }
  const subscribe = () => {
    subscriptions = [
      client.on('notice', (payload) => {
        if (
          payload &&
          typeof payload === 'object' &&
          'kind' in payload &&
          payload.kind === 'packages_changed'
        )
          refresh()
      }),
      client.on('reconnected', refresh),
      client.on('closed', () => {
        terminal = true
        scheduleRetry()
      }),
    ]
  }
  const unsubscribe = () => {
    for (const stop of subscriptions.splice(0)) stop()
  }
  const refresh = (): void => {
    if (stopped) return
    dirty = true
    if (inflight) return
    clearTimeout(retry)
    retry = undefined
    inflight = (async () => {
      try {
        if (terminal) {
          unsubscribe()
          await client.close().catch(() => undefined)
          if (stopped) return
          client = openClient()
          terminal = false
          subscribe()
        }
        const connection = client
        await connection.initialize()
        if (stopped) return
        do {
          dirty = false
          const next = await connection.surfaces.mounts()
          if (!stopped && !terminal) mounts = next.mounts.filter((row) => !isReservedMount(row.mount))
        } while (dirty && !stopped)
      } catch {
        console.error('agh serve: Surface mount table read failed; retrying in the background')
        terminal = true
        scheduleRetry()
      } finally {
        inflight = undefined
      }
    })()
  }
  subscribe()
  refresh()
  return Object.freeze({
    lookup: (pathname: string) => (mounts === undefined ? undefined : matchMount(mounts, pathname)),
    ready: () => mounts !== undefined,
    close() {
      if (closing) return closing
      stopped = true
      clearTimeout(retry)
      unsubscribe()
      // Close first to cancel an RPC on a dead connection instead of waiting for its timeout.
      closing = client
        .close()
        .then(() => inflight)
        .then(() => undefined)
      return closing
    },
  })
}

/** Convenience wrapper: `fetchSurfaceMountLookup` plus wiring the result into `createMountProxy`. */
export async function fetchSurfaceMountProxy(
  backend: LocalBackend,
  options: Readonly<{ intervalMs?: number }> = {},
): Promise<
  Readonly<{
    proxy: ReturnType<typeof createMountProxy>
    ready(pathname: string): boolean
    close(): Promise<void>
  }>
> {
  const feed = await fetchSurfaceMountLookup(backend, options)
  return Object.freeze({
    proxy: createMountProxy({ lookup: feed.lookup }),
    ready: (pathname: string) => isReservedMount(pathname) || feed.ready(),
    close: feed.close,
  })
}
