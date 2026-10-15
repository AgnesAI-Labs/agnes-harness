import type { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { rpcError } from '@agnes/protocol'
import type { WorkerPool } from './worker-pool.js'

/** Private Unix ingress for the trusted launcher; these capabilities never travel over Web RPC. */
export function registerPluginRuntimeIngress(ep: LocalEndpoint, pool: WorkerPool, transport: 'unix' | 'ws') {
  const authorize = (call: Parameters<Parameters<LocalEndpoint['register']>[1]>[1]) => {
    if (transport !== 'unix' || call.conn.authKind !== 'local' || call.conn.credentialKind !== 'local')
      throw rpcError('CAPABILITY_DENIED')
  }
  ep.register('_agnes/v1/pluginRuntime.status', async (params, call) => {
    authorize(call)
    const link = await pool.acquireSharedWorker()
    return link.command('profileManaged.status', { packageId: (params as { packageId: string }).packageId })
  })
  ep.register('_agnes/v1/pluginStreams.endpoint', async (params, call) => {
    authorize(call)
    const origin = String((params as { origin: string }).origin),
      url = new URL(origin)
    if (
      url.origin !== origin ||
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    )
      throw rpcError('CAPABILITY_DENIED')
    const link = await pool.acquireSharedWorker()
    return link.command('profileStreams.endpoint', { origin })
  })
}
