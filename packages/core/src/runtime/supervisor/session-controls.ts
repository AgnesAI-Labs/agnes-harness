import type { CallContext } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import type { MethodEntry } from './ports.js'
import { fail, race } from './wire.js'

function sessionOf(scope: W.ScopeRef): string | null {
  return scope.kind === 'session' || scope.kind === 'run' || scope.kind === 'action' ? scope.sessionId : null
}
/** A session-bearing scope may only touch its own session; the State owner still performs the real identity gate. */
function sameSession(context: CallContext, sessionId: string): boolean {
  const own = sessionOf(context.scope)
  return own === null || own === sessionId
}
const outside = () => fail('denied', 'supervisor_scope_session')
const mismatch = () => fail('internal', 'supervisor_peer_mismatch')

/** Forwards only. The single fact is State's own submitSessionControl; nothing is stored here.
 * `input` was captured by the provider before its first await, so handlers read it as is. */
export const sessionControlMethods = {
  readSessionControl: {
    needs: ['sessionControl'],
    async run(deployment, input, context) {
      const sessionId = input as W.Id
      if (!sameSession(context, sessionId)) return outside()
      const port = deployment.sessionControl
      if (!port) return fail('incompatible', 'supervisor_port_unavailable')
      const reply = await race(port.readSessionControl({ sessionId }, context), context)
      if (!reply.ok) return reply
      return reply.value.sessionId === sessionId ? reply : mismatch()
    },
  },
  submitSessionControl: {
    needs: ['sessionControl'],
    async run(deployment, input, context) {
      const request = input as W.SessionControlRequest
      if (!sameSession(context, request.sessionId)) return outside()
      const port = deployment.sessionControl
      if (!port) return fail('incompatible', 'supervisor_port_unavailable')
      const reply = await race(port.submitSessionControl(request, context), context)
      if (!reply.ok) return reply
      return reply.value.sessionId === request.sessionId && reply.value.requestId === request.requestId
        ? reply
        : mismatch()
    },
  },
  sessionControlStatus: {
    needs: ['sessionControl'],
    async run(deployment, input, context) {
      const request = input as W.SessionControlClientStatusRequest
      if (!sameSession(context, request.sessionId)) return outside()
      const port = deployment.sessionControl
      if (!port) return fail('incompatible', 'supervisor_port_unavailable')
      const reply = await race(port.sessionControlStatus(request, context), context)
      if (!reply.ok) return reply
      if (reply.value === null) return fail('invalid_input', 'not_found')
      return reply.value.sessionId === request.sessionId && reply.value.requestId === request.requestId
        ? reply
        : mismatch()
    },
  },
} satisfies Record<string, MethodEntry>
