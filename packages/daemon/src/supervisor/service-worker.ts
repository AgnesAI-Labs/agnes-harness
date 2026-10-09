import { randomBytes } from 'node:crypto'
import type { Host, ResolvedProfile } from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import type { WorkerPool } from './worker-pool.js'

function markPreDispatch(error: unknown): unknown {
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'number' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    const rpc = error as { code: number; message: string; data?: Record<string, unknown> }
    return { ...rpc, data: { ...(rpc.data ?? {}), _servicePhase: 'pre-dispatch' } }
  }
  return rpcError('INTERNAL_ERROR', { _servicePhase: 'pre-dispatch' })
}

async function callWorker(
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
  profile: () => ResolvedProfile,
  method: 'inspectService' | 'callService',
  params: Parameters<Host['callService']>[0],
  credential: Parameters<Host['callService']>[1],
  signal?: AbortSignal,
  admission?: Parameters<Host['callService']>[3],
): Promise<unknown> {
  if (signal?.aborted) throw markPreDispatch(rpcError('REQUEST_TIMEOUT'))
  profile()
  let link: Awaited<ReturnType<WorkerPool['acquire']>>
  try {
    link = await pool.acquireSharedWorker()
  } catch (error) {
    throw markPreDispatch(error)
  }
  if (link.alive === false) throw markPreDispatch(rpcError('INTERNAL_ERROR'))
  if (signal?.aborted) throw markPreDispatch(rpcError('REQUEST_TIMEOUT'))
  const callId = randomBytes(16).toString('hex')
  const abort = (): void => {
    void link.command('abortService', { callId }).catch(() => undefined)
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    return await link.command(
      method,
      {
        callId,
        sessionKey: params.sessionId,
        call: params,
        credential,
        ...(admission ? { effectCommandId: admission.commandId } : {}),
      },
      // Public capabilities cap their own deadline at 30s. This outer bound catches a wedged
      // worker event loop and still leaves the journal row uncertain for effects.
      { timeoutMs: 31_000 },
    )
  } catch (error) {
    abort()
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

/** Service calls share the daemon's single Host-bearing `@shared` business worker. */
export function workerServiceCaller(
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
  profile: () => ResolvedProfile,
): Host['callService'] {
  return async (params, credential, signal, admission) =>
    (await callWorker(pool, profile, 'callService', params, credential, signal, admission)) as Awaited<
      ReturnType<Host['callService']>
    >
}

export function workerServiceInspector(
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
  profile: () => ResolvedProfile,
): Host['inspectService'] {
  return async (params, credential, signal) =>
    (await callWorker(pool, profile, 'inspectService', params, credential, signal)) as Awaited<
      ReturnType<Host['inspectService']>
    >
}

/** Routes daemon-level Computer Use controls into the profile-scoped service worker that owns a
 * fully assembled Host. The supervisor stays kernel-free and never handles native driver state. */
export function workerComputerUseStatusSource(
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
  profile: () => ResolvedProfile,
) {
  const command = async (
    method: `computerUse.${'status' | 'doctor' | 'permissionsStatus' | 'permissionsGrant' | 'operationStart' | 'operationStatus' | 'operationCancel'}`,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    profile()
    const link = await pool.acquireSharedWorker()
    if (!link.alive) throw new Error('Computer Use service worker is unavailable')
    return link.command(method, params, { timeoutMs: 31_000 })
  }
  return Object.freeze({
    status: () => command('computerUse.status', {}),
    doctor: (params: Record<string, unknown>) => command('computerUse.doctor', params),
    permissionsStatus: () => command('computerUse.permissionsStatus', {}),
    permissionsGrant: () => command('computerUse.permissionsGrant', {}),
    operationStart: (kind: 'install' | 'update' | 'restart') =>
      command('computerUse.operationStart', { kind }),
    operationStatus: (operationId?: string) =>
      command('computerUse.operationStatus', operationId ? { operationId } : {}),
    operationCancel: (operationId: string) => command('computerUse.operationCancel', { operationId }),
    // The session worker performs the real permission-mode switch in its setYolo command.
    setSessionYolo: async () => undefined,
  })
}
