import {
  ActivationInProgressError,
  type ExtensionActivationBarrier,
  type Host,
  isServicePreDispatchFailure,
} from '@agnes/host'
import {
  type ExtensionAckParams,
  type ExtensionCallParams,
  type ExtensionCallResult,
  rpcError,
  validateMethod,
} from '@agnes/protocol'
import { commandBinding } from '../command-binding.js'
import type { CommandQueue } from '../command-queue.js'
import { runQueued } from '../command-queue.js'
import type { CallContext, LocalEndpoint } from '../endpoint.js'
import type { CommandJournal, JournalIdentity } from '../ports.js'

export type ExtensionMethodsContext = {
  activationBarrier: ExtensionActivationBarrier
  journal: CommandJournal
  commandQueue: CommandQueue
  callService: Host['callService']
  inspectService: Host['inspectService']
  /** Resolves only a server-authorized live session; returned key must equal the public id. */
  resolveServiceSession(sessionId: string, call: CallContext): Promise<string>
}

type SurfaceServiceCredential = Readonly<{
  kind: 'surface-service'
  source: string
  subjectCredential: NonNullable<CallContext['conn']['credential']>
  grants: NonNullable<CallContext['conn']['surface']>['grants']
}>

const JOURNAL_GC_INTERVAL_MS = 60_000
const nextJournalGcAt = new WeakMap<CommandJournal, number>()

function requireSurface(cx: CallContext): {
  credential: SurfaceServiceCredential
  sourceId: string
} {
  const { conn } = cx
  if (conn.authKind !== 'surface' || !conn.surface || !conn.credential) throw rpcError('CAPABILITY_DENIED')
  return {
    sourceId: conn.surface.sourceId,
    credential: Object.freeze({
      kind: 'surface-service',
      source: conn.surface.sourceId,
      subjectCredential: conn.credential,
      grants: conn.surface.grants,
    }),
  }
}

function checkedResult(value: unknown): ExtensionCallResult {
  if (!validateMethod('_agnes/v1/extension.call', 'result', value).ok) throw rpcError('INTERNAL_ERROR')
  return value as ExtensionCallResult
}

function knownPreEffectFailure(error: unknown): boolean {
  if (isServicePreDispatchFailure(error)) return true
  if (!error || typeof error !== 'object') return false
  return (error as { data?: { _servicePhase?: unknown } }).data?._servicePhase === 'pre-dispatch'
}

function sanitizedServiceFailure(error: unknown): never {
  const candidate = error as { code?: unknown; data?: { code?: unknown } }
  const code = candidate.data?.code ?? candidate.code
  if (code === 'INVALID_PARAMS') throw rpcError('INVALID_PARAMS')
  if (code === 'REQUEST_TIMEOUT') throw rpcError('REQUEST_TIMEOUT')
  if (code === 'OVERLOADED' || code === 'RESOURCE_EXHAUSTED' || code === 'QUEUE_CLOSED')
    throw rpcError('OVERLOADED')
  if (code === 'INTERNAL_ERROR') throw rpcError('INTERNAL_ERROR')
  if (code === 'E_WORKSPACE_REQUIRED') throw rpcError('INTERNAL_ERROR', { code: 'E_WORKSPACE_REQUIRED' })
  if (code === 'CAPABILITY_DENIED') throw rpcError('CAPABILITY_DENIED')
  throw rpcError('INTERNAL_ERROR')
}

/** Shared durable effect lane for surface RPC and browser-module commands. The caller must have
 * already authenticated the principal, resolved the session, checked the live service kind and
 * entered the activation barrier. */
export async function executeJournaledEffect(input: {
  journal: CommandJournal
  commandQueue: CommandQueue
  callService: Host['callService']
  params: ExtensionCallParams & Required<Pick<ExtensionCallParams, 'commandId'>>
  credential: Parameters<Host['callService']>[1]
  signal: AbortSignal
  serviceId: string
  identity: JournalIdentity
  bindingKind: string
}): Promise<ExtensionCallResult> {
  const binding = commandBinding(input.bindingKind, input.serviceId, undefined, input.params)
  const state = await input.journal.begin(input.identity, binding)
  if (state.state === 'complete') return checkedResult(state.result.result)
  if (state.state === 'uncertain') throw rpcError('OUTCOME_UNKNOWN')
  if (state.state === 'conflict') throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT' })
  if (state.state === 'corrupt') throw rpcError('INTERNAL_ERROR')

  let result: ExtensionCallResult
  let dispatched = false
  try {
    result = checkedResult(
      await runQueued(input.commandQueue, input.serviceId, input.signal, (signal) => {
        dispatched = true
        return input.callService(input.params, input.credential, signal, {
          commandId: input.params.commandId,
        })
      }),
    )
  } catch (error) {
    if (!dispatched) {
      await input.journal.abandon(input.identity)
      if (input.signal.aborted) throw rpcError('REQUEST_TIMEOUT')
      sanitizedServiceFailure(error)
    }
    if (knownPreEffectFailure(error)) {
      await input.journal.abandon(input.identity)
      sanitizedServiceFailure(error)
    }
    throw rpcError('OUTCOME_UNKNOWN')
  }
  try {
    await input.journal.complete(input.identity, { result })
  } catch {
    throw rpcError('OUTCOME_UNKNOWN')
  }
  return result
}

/** Register the one generic business RPC. Only a connection whose initialize call established both
 * Surface source and user subject may enter it; no identity-shaped request field is consulted. */
export function registerExtensions(ep: LocalEndpoint, cx: ExtensionMethodsContext): void {
  const identity = (
    p: Pick<ExtensionAckParams, 'extension' | 'service' | 'commandId'>,
    surface: ReturnType<typeof requireSurface>,
    call: CallContext,
  ): JournalIdentity => ({
    principalId: call.conn.principalId,
    clientId: surface.sourceId,
    sessionId: `service:${surface.sourceId}:${p.extension}/${p.service}`,
    commandId: p.commandId,
  })
  ep.register('_agnes/v1/extension.ack', async (params, call) => {
    const p = params as ExtensionAckParams
    const surface = requireSurface(call)
    // A receipt is acknowledged only by an explicit request sent after the caller received the
    // result. Transport close or a later request proves no such thing and must not permit GC.
    const receiptExists = await cx.journal.ack(identity(p, surface, call))
    const now = call.clock()
    // Only a real receipt can drive maintenance, and at most once per interval. This prevents random
    // or repeated ACKs from turning the indexed retention scan into request-amplification work.
    if (receiptExists && now >= (nextJournalGcAt.get(cx.journal) ?? Number.NEGATIVE_INFINITY)) {
      nextJournalGcAt.set(cx.journal, now + JOURNAL_GC_INTERVAL_MS)
      try {
        await cx.journal.gc(now)
      } catch (error) {
        nextJournalGcAt.delete(cx.journal)
        throw error
      }
    }
    return {}
  })
  const callExtension = async (params: unknown, call: CallContext): Promise<ExtensionCallResult> => {
    const p = params as ExtensionCallParams
    const surface = requireSurface(call)
    let sessionKey: string
    try {
      sessionKey = await cx.resolveServiceSession(p.sessionId, call)
    } catch (error) {
      sanitizedServiceFailure(error)
    }
    if (sessionKey !== p.sessionId) throw rpcError('CAPABILITY_DENIED')
    let kind: 'query' | 'effect'
    try {
      kind = (await cx.inspectService(p, surface.credential, call.signal)).kind
    } catch (error) {
      sanitizedServiceFailure(error)
    }
    if (kind === 'query') {
      try {
        return checkedResult(await cx.callService(p, surface.credential, call.signal))
      } catch (error) {
        sanitizedServiceFailure(error)
      }
    }
    if (!p.commandId) throw rpcError('INVALID_PARAMS')

    // The verified sourceId is the installation namespace. The client-declared label is signed by
    // the same source key but remains mutable, so allowing it to choose this key would let a BFF
    // repeat one effect under arbitrarily many labels.
    const serviceId = `service:${surface.sourceId}:${p.extension}/${p.service}`
    const journalIdentity = identity({ ...p, commandId: p.commandId }, surface, call)
    return await executeJournaledEffect({
      journal: cx.journal,
      commandQueue: cx.commandQueue,
      callService: cx.callService,
      params: { ...p, commandId: p.commandId },
      credential: surface.credential,
      signal: call.signal,
      serviceId,
      identity: journalIdentity,
      bindingKind: 'extension.call',
    })
  }
  ep.register('_agnes/v1/extension.call', (params, call) => {
    // One admission spans trusted kind inspection, journal begin and the worker call. Without this
    // outer scope an activation could start between inspect and dispatch, leaving a fresh effect row
    // looking uncertain even though no handler crossed the boundary.
    let invocation: ReturnType<ExtensionActivationBarrier['admit']>
    try {
      invocation = cx.activationBarrier.admit('service')
    } catch (error) {
      if (error instanceof ActivationInProgressError)
        throw rpcError('OVERLOADED', {
          reason: error.reason,
          operationId: error.operationId,
          retryAfterMs: 500,
        })
      throw error
    }
    return invocation.run(() => callExtension(params, call))
  })
}
