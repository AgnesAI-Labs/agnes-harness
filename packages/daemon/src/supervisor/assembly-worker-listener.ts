import type { AssemblyLifetime } from './assembly-lifetime.js'
import type { AssemblyBase } from './assembly-options.js'
import type { WorkersState } from './assembly-workers.js'
import { listenUnix } from './socket.js'

export async function listenWorkers(state: AssemblyBase & WorkersState, lifetime: AssemblyLifetime) {
  const { o, pool } = state
  // Runtime initialization may validate or bootstrap active extensions in a real service worker,
  // so the private listener must exist before initialize() can acquire that worker.
  const failure: { error?: Error } = {}
  const listenWorkers = () => listenUnix(o.config.workersSocketPath, (socket) => pool.adopt(socket))
  const workersServer = await (o.bootVerification?.outside(listenWorkers) ?? listenWorkers())
  lifetime.own({ dispose: () => workersServer.close() })
  void workersServer.failed?.then((error) => {
    failure.error = error
  })
  return { workersServer, failure }
}

export type ListenerState = Awaited<ReturnType<typeof listenWorkers>>
