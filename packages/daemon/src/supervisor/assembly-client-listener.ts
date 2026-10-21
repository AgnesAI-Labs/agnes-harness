import { randomBytes } from 'node:crypto'
import { startClaimsGc } from '@agnes/daemon-foundation/storage/claims-table'
import type { EndpointsState } from './assembly-endpoints.js'
import type { AssemblyLifetime } from './assembly-lifetime.js'
import type { AssemblyBase } from './assembly-options.js'
import type { RuntimeState } from './assembly-runtime.js'
import type { SessionsState } from './assembly-session-services.js'
import type { StoresState } from './assembly-stores.js'
import type { ListenerState } from './assembly-worker-listener.js'
import type { WorkersState } from './assembly-workers.js'
import type { DaemonConfig } from './config.js'
import { bindConnection } from './connection.js'
import { listenUnix } from './socket.js'
import { listenWebSocket } from './ws.js'

export async function listenClients(
  state: AssemblyBase &
    StoresState &
    WorkersState &
    RuntimeState &
    SessionsState &
    EndpointsState &
    ListenerState,
  lifetime: AssemblyLifetime,
) {
  const { o, clock, conns, persistentClaims, pool, registry, scheduler, endpoint, workersServer, failure } =
    state
  lifetime.own({
    stop: () => closeConnections(conns, (ep) => ep.stopIntake()),
    dispose: () => closeConnections(conns, (ep) => ep.close()),
  })
  const server = await listenUnix(o.config.socketPath, (socket) => {
    const { ep, onClose } = endpoint('unix')
    bindConnection(socket, ep, { onClose })
  })
  lifetime.own({ stop: () => server.stopAccepting(), dispose: () => server.close() })
  void server.failed?.then((error) => {
    failure.error = error
  })
  const health: { failed?: Promise<Error> } = {
    failed: Promise.race(
      [workersServer.failed, server.failed].filter((value): value is Promise<Error> => value !== undefined),
    ),
  }
  const wsToken = o.config.ws || o.config.localWeb ? randomBytes(32).toString('base64url') : undefined
  const wsServer =
    (o.config.ws || o.config.localWeb) && wsToken
      ? await listenWebSocket({
          ...(o.config.localWeb
            ? { addr: o.config.localWeb.addr, localOrigin: o.config.localWeb.origin }
            : (o.config.ws as NonNullable<DaemonConfig['ws']>)),
          token: wsToken,
          endpoint: () => {
            const { ep, onClose } = endpoint('ws')
            return { endpoint: ep, onClose }
          },
        })
      : undefined
  if (wsServer) lifetime.own({ stop: () => wsServer.stopAccepting(), dispose: () => wsServer.close() })

  const evictIdleNow = (): number =>
    pool.evictIdle(clock(), (sessionKey) => !!registry.get(sessionKey)?.inflight)
  const retireSharedWorkerNow = (): boolean => pool.retireSharedWorkerNow()
  const evict = setInterval(() => {
    evictIdleNow()
  }, 60_000)
  evict.unref()
  lifetime.own({ stop: () => clearInterval(evict), dispose: () => undefined })
  const stopClaimsGc = persistentClaims ? startClaimsGc(persistentClaims, clock) : undefined
  if (stopClaimsGc) lifetime.own({ stop: stopClaimsGc, dispose: () => undefined })
  scheduler?.start()

  return { health, wsServer, wsToken, evictIdleNow, retireSharedWorkerNow }
}

export type ListeningState = Awaited<ReturnType<typeof listenClients>>

async function closeConnections(
  conns: StoresState['conns'],
  action: (ep: import('@agnes/daemon-foundation/local/endpoint').LocalEndpoint) => void | Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    [...conns].map(({ ep }) => Promise.resolve().then(() => action(ep))),
  )
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
  if (errors.length) throw new AggregateError(errors, 'daemon connection cleanup failed')
}
