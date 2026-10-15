import { CoreError } from '@agnes/core-common/types'
import type { LoopSideCallPort } from '@agnes/extension-api'
import { createSideCallEffectPort } from '../orchestrator/side-call-effect-port.js'
import { executeSideCall } from '../orchestrator/side-call-executor.js'
import type { SessionImpl } from '../step/session.js'
import { sessionIdentity } from './scope.js'
import { checkInvocationId, noTurn, sideCallRequests } from './side-call-request.js'

/** The effect ids of side calls running in this process, by session. */
const running = new WeakMap<object, Set<string>>()

/** Whether a side call of this session is between its admission and its settlement. */
export function sideCallInFlight(s: SessionImpl): boolean {
  return (running.get(sessionIdentity(s))?.size ?? 0) > 0
}

const inFlight = () =>
  new CoreError('E_RELATION', 'Side call invocation is already running', { reason: 'invocation-in-flight' })

/**
 * The side-call port of one loop context, over its loop-scoped session. A call is sent at most once
 * per invocation id: an id with a recorded result is answered from the ledger, and an id that is in
 * flight, here or in a context that was replaced, is refused.
 */
export function createSideCallPort(s: SessionImpl): LoopSideCallPort {
  const requests = sideCallRequests(s)
  const effects = createSideCallEffectPort(s)
  return {
    async prepare(options) {
      const done = s.beginLoopOperation()
      try {
        return await requests.prepare(options)
      } finally {
        done()
      }
    },
    async invoke(prepared, signal) {
      // Checked before anything is held or written: the execution races this signal.
      if (!(signal instanceof AbortSignal))
        throw new CoreError('E_ENVELOPE', 'Side call signal must be an AbortSignal', { reason: 'signal' })
      const releaseEffect = await s.controls.beginEffect()
      const done = s.beginLoopOperation()
      try {
        const call = requests.resolve(prepared)
        const op = s.op()
        if (!op) throw noTurn()
        if (!s.turn) await s.rehydrateTurn(op)
        const { effectId } = call.binding
        const owner = sessionIdentity(s)
        const claims = running.get(owner) ?? new Set<string>()
        if (claims.has(effectId)) throw inFlight()
        claims.add(effectId)
        running.set(owner, claims)
        try {
          const prior = await effects.status(call.prepared.invocationId)
          if (prior.status === 'in-flight') throw inFlight()
          if (prior.status === 'finished') {
            if (prior.requestHash !== call.prepared.requestHash)
              throw new CoreError('E_RELATION', 'Side call invocation id was used for another request', {
                reason: 'invocation-reused',
              })
            return prior.result
          }
          return await executeSideCall(s, effects, call, signal)
        } finally {
          claims.delete(effectId)
          if (!claims.size && running.get(owner) === claims) running.delete(owner)
        }
      } finally {
        done()
        releaseEffect()
      }
    },
    async status(invocationId) {
      const done = s.beginLoopOperation()
      try {
        return await effects.status(checkInvocationId(invocationId))
      } finally {
        done()
      }
    },
  }
}
