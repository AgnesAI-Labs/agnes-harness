import { type FrontendPublication, frontendPublication, REMOTE_FRONTEND_SERVICE } from '@agnes/protocol'
import { createClient, memoryJournal } from '@agnes/sdk'
import { createPublishedFrontend } from '@agnes/web/server'
import { localPipeFactories } from '../src/boot/pipe-factory.js'
import type { LocalBackend } from './backend.js'

export type PublicationLease = { identity: string; publication: FrontendPublication }

/** The current installed roster, not a pinned session or the presence of a package on disk. */
export async function readFrontendPublication(
  client: Pick<ReturnType<typeof createClient>, 'clientModules' | 'call'>,
  profile: string,
): Promise<PublicationLease | undefined> {
  const roster = await client.clientModules.list(profile)
  const rows = roster.rows.filter(
    (row) =>
      row.enabled &&
      row.phase === 'ready' &&
      row.services?.includes(REMOTE_FRONTEND_SERVICE) &&
      row.extIds?.includes(row.moduleName),
  )
  if (rows.length === 0) return undefined
  if (rows.length !== 1) throw new Error('only one frontend publication may be active')
  const row = rows[0]
  if (!row) throw new Error('missing publication owner')
  const result = await client.call<{ output: unknown }>('_agnes/v1/extension.callScoped', {
    extension: row.moduleName,
    service: REMOTE_FRONTEND_SERVICE,
    input: {},
  })
  const publication = frontendPublication(result.output)
  if (!publication.enabled) return undefined
  return {
    identity: JSON.stringify([row.rowId, row.revision, row.contentDigest, row.binding, publication]),
    publication,
  }
}

export async function watchFrontendPublication(input: {
  read(): Promise<PublicationLease | undefined>
  open(
    lease: PublicationLease,
    current: () => Promise<boolean>,
  ): Promise<{ url: string; close(): Promise<void> }>
  report?(status: string): void
  intervalMs?: number
}) {
  let closed = false
  let active: { lease: PublicationLease; server: Awaited<ReturnType<typeof input.open>> } | undefined
  let running: Promise<void> | undefined
  let lastStatus = ''
  const report = (status: string) => {
    if (lastStatus !== status) {
      lastStatus = status
      input.report?.(status)
    }
  }
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve()
    if (running) return running
    running = (async () => {
      let next: PublicationLease | undefined
      try {
        next = await input.read()
      } catch {
        report('publication unavailable')
      }
      if (closed) return
      if (active?.lease.identity === next?.identity) return
      const previous = active
      active = undefined
      await previous?.server.close()
      if (closed || !next) {
        if (previous) report('publication stopped')
        return
      }
      const lease = next
      try {
        const server = await input.open(lease, async () => {
          if (closed || active?.lease !== lease) return false
          try {
            return (await input.read())?.identity === lease.identity && !closed && active?.lease === lease
          } catch {
            return false
          }
        })
        if (closed) {
          await server.close()
          return
        }
        active = { lease, server }
        report(`${lease.publication.access} frontend: ${server.url}`)
      } catch {
        report('publication failed to start; check listener and TLS configuration')
      }
    })().finally(() => {
      running = undefined
    })
    return running
  }
  await refresh()
  const timer = setInterval(() => {
    void refresh()
  }, input.intervalMs ?? 500)
  timer.unref()
  return {
    refresh,
    async close() {
      closed = true
      clearInterval(timer)
      await running
      await active?.server.close()
      active = undefined
    },
  }
}

/** Only an installed and trusted plugin can opt the local owner's complete service into publication. */
export async function startFrontendPublication(
  backend: LocalBackend,
  webOrigin: string,
  report: (status: string) => void,
  wsUrl: () => string = () => backend.web?.url ?? '',
) {
  const open = () =>
    createClient({
      transport: { kind: 'unix', path: backend.socketPath },
      transportFactories:
        backend.link?.transportFactories() ?? localPipeFactories(backend.socketPath, backend.scope),
      auth: { kind: 'local' },
      journal: memoryJournal(`publication-${backend.scope.scopeID}`),
    })
  const client = backend.link ? backend.link.client(open) : open()
  const watcher = await watchFrontendPublication({
    read: async () => {
      await client.initialize()
      return readFrontendPublication(client, backend.scope.profile)
    },
    open: (lease, current) =>
      createPublishedFrontend({
        publication: lease.publication,
        webOrigin,
        wsUrl,
        current,
        instanceId: backend.scope.scopeID,
      }),
    report,
  })
  const off = client.on('notice', () => {
    void watcher.refresh()
  })
  return {
    async close() {
      off()
      await watcher.close()
      await client.close()
    },
  }
}
