import { enqueueSystemInput, type Host, type HostSession } from '@agnes/host'
import { type Actor, rpcError } from '@agnes/protocol'
import type { WorkerCommandFrame } from './frames.js'
import { profileStreamEndpoint } from './profile-stream-server.js'

export async function deliverBoundSystemInput(
  session: HostSession,
  host: Host,
  p: Record<string, unknown>,
): Promise<number> {
  if (
    session.closingOrClosed ||
    p.targetActorId !== session.d.actor.id ||
    (p.targetActorOrg !== undefined && p.targetActorOrg !== session.d.actor.org) ||
    p.laneId !== session.lane ||
    p.generationId !== (host.sessionGeneration?.(session.key) ?? host.profile.hash)
  )
    throw rpcError('CAPABILITY_DENIED')
  return enqueueSystemInput(
    session,
    String(p.commandId),
    p.system as import('@agnes/protocol').SystemInput,
    p.actor as Actor,
    new AbortController().signal,
  )
}

export async function profileServiceCommand(
  host: Host | undefined,
  cmd: WorkerCommandFrame,
  aborts: Map<string, AbortController>,
): Promise<unknown> {
  const p = cmd.params
  switch (cmd.method) {
    case 'profileManaged.status': {
      const manager = host?.profileServices?.managed
      if (!manager) throw rpcError('CAPABILITY_DENIED')
      await manager.settle().catch(() => undefined)
      return {
        resources: manager
          .statuses(String(p.packageId))
          .map(({ id, state, code }) => ({ id, state, ...(code ? { code } : {}) })),
      }
    }
    case 'profileStreams.endpoint':
      if (!host) throw rpcError('CAPABILITY_DENIED')
      return profileStreamEndpoint(host, String(p.origin))
    case 'boundWake.resolve':
      if (!host?.profileServices) throw rpcError('CAPABILITY_DENIED')
      return host.profileServices.resolveWake(String(p.bindingId), p.credential)
    case 'boundWake.read':
      if (!host?.profileServices) throw rpcError('CAPABILITY_DENIED')
      return host.profileServices.readWake(String(p.bindingId))
    case 'boundWake.require':
      if (!host?.profileServices) throw rpcError('CAPABILITY_DENIED')
      return host.profileServices.requireWake(String(p.bindingId))
    case 'profileService.identity':
    case 'profileService.authorizeControl':
    case 'profileService.call':
    case 'profileService.readOperation':
    case 'profileService.listDecisions':
    case 'profileService.answerDecision': {
      if (!host?.profileServices) throw rpcError('CAPABILITY_DENIED')
      const method = cmd.method.slice('profileService.'.length)
      if (method === 'identity')
        return host.profileServices.serviceIdentity(
          p.call as import('@agnes/protocol').ProfileServiceCallParams,
          p.credential,
        )
      if (method === 'authorizeControl')
        return host.profileServices.authorizeControl(
          p.call as import('@agnes/protocol').ProfileServiceOperationParams,
          p.credential,
        )
      if (method === 'listDecisions') return host.profileServices.listDecisionState(p.credential)
      if (method === 'answerDecision')
        return host.profileServices.answerDecision(
          p.call as import('@agnes/protocol').ProfileDecisionAnswerParams,
          p.credential,
        )
      if (method === 'readOperation')
        return host.profileServices.readOperation(
          p.call as import('@agnes/protocol').ProfileServiceOperationParams,
          p.credential,
        )
      const callId = String(p.callId)
      if (!callId || aborts.has(callId)) throw rpcError('CAPABILITY_DENIED')
      const controller = new AbortController()
      aborts.set(callId, controller)
      try {
        return await host.profileServices.call(
          p.call as import('@agnes/protocol').ProfileServiceCallParams,
          p.credential,
          controller.signal,
        )
      } finally {
        aborts.delete(callId)
      }
    }
    default:
      throw rpcError('CAPABILITY_DENIED')
  }
}

export const isProfileCommand = (method: string) =>
  ['profileManaged.', 'profileStreams.', 'profileService.', 'boundWake.'].some((prefix) =>
    method.startsWith(prefix),
  )
