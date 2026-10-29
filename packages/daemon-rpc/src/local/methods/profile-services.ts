import type { BoundWakeService } from '@agnes/daemon-foundation/jobs/bound-wakes'
import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { Host } from '@agnes/host'
import {
  type ProfileDecisionAnswerParams,
  type ProfileServiceCallParams,
  type ProfileServiceOperationParams,
  rpcError,
} from '@agnes/protocol'

type Runtime = NonNullable<Host['profileServices']>
/** Fixed profile ingress. A page cannot submit actor, role, owner, profile or approval proof. */
export function registerProfileServices(
  ep: LocalEndpoint,
  runtime: Pick<Runtime, 'call' | 'readOperation' | 'listDecisions' | 'answerDecision'> & {
    listDecisionState?(credential: unknown): Promise<{
      principal: { id: string; org: string }
      decisions: import('@agnes/protocol').DecisionSnapshot[]
    }>
  },
  wakes?: BoundWakeService,
  barrier?: Host['activationBarrier'],
  requireSessionRead?: (method: string, sessionId: string, call: CallContext) => void,
): void {
  const serviceCredential = (call: CallContext, params: { extension: string; service: string }) => {
    const { conn } = call
    if (conn.authKind === 'surface' && conn.surface && conn.credential)
      return {
        kind: 'surface-service',
        source: conn.surface.sourceId,
        subjectCredential: conn.credential,
        grants: conn.surface.grants,
      }
    // Local workbench/client ingress is already authenticated by the endpoint. Channel and source
    // credentials cannot use the local human path or grant themselves arbitrary services.
    if (conn.authKind !== 'local' || conn.credentialKind !== 'local') throw rpcError('CAPABILITY_DENIED')
    return {
      kind: 'surface-service',
      source: 'client-web',
      subjectCredential: { kind: 'local' },
      grants: [{ extension: params.extension, name: params.service, range: '*' }],
    }
  }
  const humanCredential = (call: CallContext): unknown => {
    if (call.conn.authKind !== 'local' || call.conn.credentialKind !== 'local')
      throw rpcError('CAPABILITY_DENIED')
    return { kind: 'local' }
  }
  if (wakes) {
    const wakeCredential = (call: CallContext): unknown => {
      const { conn } = call
      if (conn.authKind !== 'surface' || !conn.surface || !conn.credential)
        throw rpcError('CAPABILITY_DENIED')
      return {
        kind: 'surface-service',
        source: conn.surface.sourceId,
        subjectCredential: conn.credential,
        grants: conn.surface.grants,
      }
    }
    ep.register('_agnes/v1/extension.wakes.enqueue', (params, call) =>
      wakes.enqueue(params as import('@agnes/protocol').BoundWakeEnqueueParams, wakeCredential(call)),
    )
    ep.register('_agnes/v1/extension.wakes.read', (params, call) =>
      wakes.read((params as { wakeId: string }).wakeId, wakeCredential(call)),
    )
  }
  ep.register('_agnes/v1/extension.callScoped', (params, call) => {
    const p = params as ProfileServiceCallParams
    const invoke = () => {
      const sessionReads = Object.freeze([...(p.sessionReads ?? [])])
      for (const sessionId of sessionReads) {
        if (!requireSessionRead) throw rpcError('CAPABILITY_DENIED')
        requireSessionRead('extension.callScoped', sessionId, call)
      }
      return runtime.call(
        p,
        { ...serviceCredential(call, p), ...(p.sessionReads !== undefined ? { sessionReads } : {}) },
        call.signal,
      )
    }
    return barrier ? barrier.admit('service').run(invoke) : invoke()
  })
  ep.register('_agnes/v1/extension.readOperation', (params, call) => {
    const p = params as ProfileServiceOperationParams
    return runtime.readOperation(p, serviceCredential(call, p))
  })
  ep.register('_agnes/v1/profile.decisions.list', async (_params, call) => {
    const credential = humanCredential(call)
    if (!runtime.listDecisionState) return { decisions: await runtime.listDecisions(credential) }
    const state = await runtime.listDecisionState(credential)
    // The transport principal label is not the seam's actor identity. Bind only backend evidence.
    call.conn.decisionPrincipal = state.principal
    return { decisions: state.decisions }
  })
  ep.register('_agnes/v1/profile.decisions.answer', (params, call) =>
    runtime.answerDecision(params as ProfileDecisionAnswerParams, humanCredential(call)),
  )
}
