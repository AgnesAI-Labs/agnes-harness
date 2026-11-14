import { CoreError } from '@agnes/core-common/types'
import { createBackgroundAppendAuthority } from '@agnes/core-ledger/log/session-log'
import type { SideCallPort } from '@agnes/extension-api'
import { createSideCallEffectPort } from '../orchestrator/side-call-effect-port.js'
import {
  executeSideCall,
  type IndependentSideCallExecution,
  type SideCallExecutionSource,
} from '../orchestrator/side-call-executor.js'
import { LoopScope } from '../step/loop-deadline.js'
import type { SessionImpl } from '../step/session.js'
import { sessionForLoop, sessionIdentity } from './scope.js'
import { namespacedInvocationId, type ScopedSideCallPort } from './scoped-side-call.js'
import { inFlight } from './side-call-receipts.js'
import { sideCallRequests } from './side-call-request.js'

const claims = new WeakMap<object, Set<string>>()
const billingFailures = new WeakSet<object>()

/** Fresh authority for one completed source. It owns no foreground operation or turn claim. */
export function createSessionWorkSideCall(
  session: SessionImpl,
  input: { caller: string; source: SideCallExecutionSource; signal?: AbortSignal },
): ScopedSideCallPort & { spendAllowed(): boolean; billingFailed(): void; drained(): Promise<void> } {
  const controller = new AbortController()
  const scope = new LoopScope()
  const authority = createBackgroundAppendAuthority(session.d.log, input.source, input.caller)
  const s = sessionForLoop(session, { scope, controller, backgroundAuthority: authority.token })
  const owner = sessionIdentity(session)
  const execution: IndependentSideCallExecution = {
    source: Object.freeze({ ...input.source }),
    get ledgerFailed() {
      return billingFailures.has(owner)
    },
    set ledgerFailed(failed: boolean) {
      if (failed) billingFailures.add(owner)
    },
  }
  const { turn, startSeq, endSeq, lastAssistantSeq } = execution.source
  const requests = sideCallRequests(s, input.caller, { turn, startSeq, endSeq, lastAssistantSeq })
  const effects = createSideCallEffectPort(s)
  const pending = new Set<Promise<unknown>>()
  const transports = new Set<Promise<void>>()
  const identity = session.state.session
  let closed = false
  const cancel = () => {
    authority.revoke()
    controller.abort()
    scope.revoke()
  }
  const off = session.onCancelled(cancel)
  input.signal?.addEventListener('abort', cancel, { once: true })
  if (input.signal?.aborted) cancel()
  const assertLive = () => {
    if (closed || controller.signal.aborted || session.closingOrClosed || session.state.session !== identity)
      throw new CoreError('E_CLOSED', 'Background invocation is closed')
    scope.assertAlive()
    const actual = session.state.completedTurns.get(endSeq)
    if (
      !execution.source.hard &&
      (!actual ||
        actual.lane !== session.lane ||
        actual.turn !== turn ||
        actual.startSeq !== startSeq ||
        actual.lastAssistantSeq !== lastAssistantSeq)
    )
      throw new CoreError('E_RELATION', 'Background source boundary is not a completed turn')
  }
  const track = <T>(work: () => Promise<T>) => {
    const promise = Promise.resolve().then(() => {
      assertLive()
      return work()
    })
    pending.add(promise)
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    )
    return promise
  }
  const port: SideCallPort = {
    prepare: (options) =>
      track(async () => {
        const prepared = await requests.prepare({
          ...options,
          invocationId: namespacedInvocationId(input.caller, options.invocationId ?? s.d.ids.effectId()),
        })
        assertLive()
        return prepared
      }),
    invoke: (prepared, signal) => {
      let transport = Promise.resolve()
      let release = () => {}
      const logical = track(async () => {
        if (!(signal instanceof AbortSignal))
          throw new CoreError('E_ENVELOPE', 'Invalid side call signal', { reason: 'signal' })
        const call = requests.resolve(prepared)
        const held = claims.get(owner) ?? new Set<string>()
        const id = call.binding.effectId
        if (held.has(id)) throw inFlight()
        held.add(id)
        claims.set(owner, held)
        release = () => {
          held.delete(id)
        }
        const prior = await effects.status(prepared.invocationId)
        assertLive()
        if (prior.status === 'in-flight') throw inFlight()
        if (prior.status === 'finished') {
          if (prior.requestHash !== prepared.requestHash)
            throw new CoreError('E_RELATION', 'Side call identity reused', { reason: 'invocation-reused' })
          return prior.result
        }
        return executeSideCall(s, effects, call, AbortSignal.any([signal, controller.signal]), {
          source: execution.source,
          get ledgerFailed() {
            return execution.ledgerFailed
          },
          set ledgerFailed(failed: boolean) {
            execution.ledgerFailed = failed
          },
          retainTransport(work) {
            transport = work
            transports.add(work)
            void work.finally(() => {
              transports.delete(work)
            })
          },
        })
      })
      return logical
        .then(
          async (result) => {
            await transport
            return result
          },
          async (error: unknown) => {
            await transport
            throw error
          },
        )
        .finally(() => release())
    },
    status: (id) => track(() => effects.status(namespacedInvocationId(input.caller, id))),
  }
  return Object.freeze({
    ...port,
    drained: async () => {
      while (transports.size) await Promise.allSettled([...transports])
    },
    spendAllowed: () => !execution.ledgerFailed && !execution.source.hard,
    billingFailed: () => {
      execution.ledgerFailed = true
    },
    async close() {
      closed = true
      cancel()
      off()
      input.signal?.removeEventListener('abort', cancel)
      await Promise.allSettled([...pending])
    },
  })
}
