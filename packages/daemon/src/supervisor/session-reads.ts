import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { rpcError, type SessionRuntimeParams, type SessionViewParams } from '@agnes/protocol'
import type { WorkerPool } from './worker-pool.js'

/** Read through the shared Host without opening a session or acquiring its writer lease. */
export function registerWorkerSessionReads(
  endpoint: LocalEndpoint,
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
  requireOwner: (method: string, sessionId: string, context: CallContext) => void,
): void {
  endpoint.register('_agnes/v1/session.runtime', async (params, context) => {
    const input = params as SessionRuntimeParams
    requireOwner('session.runtime', input.sessionId, context)
    const link = await pool.acquireSharedWorker()
    return link.command('session.runtime', input)
  })
  endpoint.register('_agnes/v1/session.view', async (params, context) => {
    const input = params as SessionViewParams
    requireOwner('session.view', input.sessionId, context)
    const link = await pool.acquireSharedWorker()
    return link.command('session.view', input)
  })
}

/** Decodes the `[activity, key]` keyset position this lister issued for the previous page. */
export function recencyCursor(cursor: string | undefined): { at: string; key: string } | undefined {
  if (cursor === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(cursor)
  } catch {
    value = undefined
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string'
  )
    throw rpcError('INVALID_PARAMS', { reason: 'session list cursor is malformed' })
  return { at: value[0], key: value[1] }
}
