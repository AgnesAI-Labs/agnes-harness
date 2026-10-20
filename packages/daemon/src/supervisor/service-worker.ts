import { randomBytes } from 'node:crypto'
import type { Host, ResolvedProfile } from '@agnes/host'
import {
  type ClientModuleServiceCallParams,
  type ExtensionCallParams,
  type ExtensionCallResult,
  rpcError,
} from '@agnes/protocol'
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

/** Resolution runs in the same session-routed Host as the subsequent service call. */
export function workerServiceResolver(pool: Pick<WorkerPool, 'acquireSharedWorker'>): Host['resolveService'] {
  return async (sessionKey, names) => {
    const link = await pool.acquireSharedWorker()
    return (await link.command('resolveService', { sessionKey, names })) as Awaited<
      ReturnType<Host['resolveService']>
    >
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

/** Current profile calls always use the shared worker, independent of any session pin. */
export function workerProfileServices(
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
  gate?: (identity: { packageId: string; integrity: string }) => Promise<void>,
) {
  type Runtime = NonNullable<Host['profileServices']>
  const command = async (
    method: 'call' | 'readOperation' | 'listDecisions' | 'answerDecision' | 'authorizeControl' | 'identity',
    call: unknown,
    credential: unknown,
  ): Promise<unknown> => {
    const link = await pool.acquireSharedWorker()
    return link.command(`profileService.${method}`, { call, credential }, { timeoutMs: 31000 })
  }
  return {
    authorizeControl: (async (params, credential) => {
      if (gate)
        await gate(
          (await command('identity', params, credential)) as Awaited<ReturnType<Runtime['serviceIdentity']>>,
        )
      return command('authorizeControl', params, credential)
    }) as Runtime['authorizeControl'],
    call: (async (params, credential, signal) => {
      if (signal?.aborted) throw rpcError('REQUEST_TIMEOUT')
      const link = await pool.acquireSharedWorker()
      if (signal?.aborted) throw rpcError('REQUEST_TIMEOUT')
      if (gate)
        await gate(
          (await link.command('profileService.identity', { call: params, credential })) as Awaited<
            ReturnType<Runtime['serviceIdentity']>
          >,
        )
      if (signal?.aborted) throw rpcError('REQUEST_TIMEOUT')
      const callId = randomBytes(16).toString('hex')
      const abort = () => {
        void link.command('abortService', { callId }).catch(() => undefined)
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        return await link.command(
          'profileService.call',
          { callId, call: params, credential },
          { timeoutMs: 31000 },
        )
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    }) as Runtime['call'],
    readOperation: (async (params, credential) =>
      command('readOperation', params, credential)) as Runtime['readOperation'],
    listDecisionState: async (credential: unknown) =>
      (await command('listDecisions', {}, credential)) as {
        principal: { id: string; org: string }
        decisions: import('@agnes/protocol').DecisionSnapshot[]
      },
    listDecisions: (async (credential) =>
      (
        (await command('listDecisions', {}, credential)) as {
          decisions: import('@agnes/protocol').DecisionSnapshot[]
        }
      ).decisions) as Runtime['listDecisions'],
    answerDecision: (async (params, credential) =>
      command('answerDecision', params, credential)) as Runtime['answerDecision'],
  }
}

export function workerWakeBindings(
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
  gate?: (identity: { packageId: string; integrity: string }) => Promise<void>,
) {
  type Runtime = NonNullable<Host['profileServices']>
  return {
    read: async (bindingId: string) => {
      const link = await pool.acquireSharedWorker()
      return (await link.command('boundWake.read', { bindingId })) as ReturnType<Runtime['readWake']>
    },
    resolve: async (bindingId: string, credential: unknown) => {
      const link = await pool.acquireSharedWorker()
      const resolved = (await link.command('boundWake.resolve', { bindingId, credential })) as Awaited<
        ReturnType<Runtime['resolveWake']>
      >
      if (gate) {
        try {
          await gate({
            packageId: resolved.binding.producerPackageId ?? '',
            integrity: resolved.binding.producerIntegrity,
          })
        } catch (error) {
          if ((error as { data?: { code?: string } })?.data?.code !== 'CAPABILITY_DENIED') throw error
          resolved.active = false
        }
      }
      return resolved
    },
    require: async (bindingId: string) => {
      const link = await pool.acquireSharedWorker()
      const target = (await link.command('boundWake.require', { bindingId })) as ReturnType<
        Runtime['requireWake']
      >
      if (gate) await gate({ packageId: target.producerPackageId ?? '', integrity: target.producerIntegrity })
      return target
    },
  }
}

/** A ready client row receives one query grant; Host repeats session and principal checks. */
export function createClientServiceDispatcher(
  callService: Host['callService'],
  inspectService: Host['inspectService'],
) {
  return async (
    input: ClientModuleServiceCallParams & Readonly<{ packageId: string; extension: string }>,
  ): Promise<ExtensionCallResult> => {
    const params: ExtensionCallParams = {
      sessionId: input.sessionId,
      extension: input.extension,
      service: input.service,
      input: input.input,
    }
    // Synthesized only after a fresh ready-row/manifest match; it never crosses the browser
    // boundary and has one query service grant rather than generic daemon authority.
    const credential = Object.freeze({
      kind: 'surface-service' as const,
      // `client-web` is a dedicated server-side principal for the authenticated loopback BFF.
      // It is deliberately not derived from profile/row text: the worker service-authority
      // envelope allows only a bounded source grammar and the row itself is already held in the
      // exact grant below.
      source: 'client-web',
      subjectCredential: Object.freeze({ kind: 'local' }),
      grants: Object.freeze([{ extension: input.extension, name: input.service, range: '*' }]),
    })
    const inspection = await inspectService(params, credential)
    if (inspection.kind !== 'query') throw rpcError('CAPABILITY_DENIED')
    return await callService(params, credential)
  }
}

/** One set of Host service adapters for the shared worker and its private web dispatcher. */
export function workerClientServices(
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
  profile: () => ResolvedProfile,
) {
  const callService = workerServiceCaller(pool, profile)
  const inspectService = workerServiceInspector(pool, profile)
  return {
    callService,
    inspectService,
    resolveService: workerServiceResolver(pool),
    dispatchClientService: createClientServiceDispatcher(callService, inspectService),
  }
}
