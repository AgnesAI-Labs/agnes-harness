import type { Host } from '@agnes/host'
import { type ExtensionCallParams, rpcError } from '@agnes/protocol'
import type { WorkerCommandFrame } from './frames.js'

/** Session-scoped service commands share the admitted session and abort registry. */
export async function sessionServiceCommand(
  host: Host | undefined,
  cmd: WorkerCommandFrame,
  aborts: Map<string, AbortController>,
): Promise<unknown> {
  const p = cmd.params
  switch (cmd.method) {
    case 'resolveService': {
      if (
        !host ||
        typeof p.sessionKey !== 'string' ||
        !Array.isArray(p.names) ||
        !p.names.every((name) => typeof name === 'string')
      )
        throw rpcError('INVALID_PARAMS')
      return (await host.resolveService(p.sessionKey, p.names)) ?? null
    }
    case 'inspectService': {
      if (!host) throw new Error('generic services are unavailable in a resource lifecycle worker')
      const params = p.call as ExtensionCallParams | undefined
      if (
        typeof p.sessionKey !== 'string' ||
        p.sessionKey.length === 0 ||
        !params ||
        params.sessionId !== p.sessionKey
      )
        throw rpcError('CAPABILITY_DENIED')
      const callId = String(p.callId)
      if (!callId || aborts.has(callId)) throw new Error('duplicate service call id')
      const ac = new AbortController()
      aborts.set(callId, ac)
      try {
        return await host.inspectService(params, p.credential, ac.signal)
      } finally {
        aborts.delete(callId)
      }
    }
    case 'callService': {
      if (!host) throw new Error('generic services are unavailable in a resource lifecycle worker')
      const params = p.call as ExtensionCallParams | undefined
      if (
        typeof p.sessionKey !== 'string' ||
        p.sessionKey.length === 0 ||
        !params ||
        params.sessionId !== p.sessionKey
      )
        throw rpcError('CAPABILITY_DENIED')
      const callId = String(p.callId)
      if (!callId || aborts.has(callId)) throw new Error('duplicate service call id')
      const ac = new AbortController()
      aborts.set(callId, ac)
      try {
        const admission = p.effectCommandId
        return await host.callService(
          params,
          p.credential,
          ac.signal,
          typeof admission === 'string' ? { commandId: admission } : undefined,
        )
      } finally {
        aborts.delete(callId)
      }
    }
    default:
      throw rpcError('INVALID_PARAMS')
  }
}
