import { sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import type { SideCallPort } from '@agnes/extension-api'
import type { ToolSource } from '../registry/tools.js'
import type { SessionImpl } from '../step/session.js'
import { sessionForLoop } from './scope.js'
import { createSideCallPort } from './side-call.js'
import { checkInvocationId } from './side-call-request.js'

export function namespacedInvocationId(caller: string, id: string): string {
  if (typeof id !== 'string' || id.length > 112)
    throw new CoreError('E_REQUEST', 'Side call invocationId must be at most 112 characters')
  return checkInvocationId(`c${sha256Hex(caller).slice(0, 8)}:${checkInvocationId(id)}`)
}

export type ScopedSideCallPort = SideCallPort & { close(): Promise<void> }

/** One hook or tool invocation owns its prepared calls and all work it starts. */
export function createScopedSideCallPort(
  session: SessionImpl,
  scope: { caller: string; kind: 'hook' | 'tool'; scopeId: string },
): ScopedSideCallPort {
  const s = sessionForLoop(session)
  const turn = s.op()?.meta.turn
  const port = createSideCallPort(s, scope.caller)
  const controller = new AbortController()
  const pending = new Set<Promise<unknown>>()
  let closed = false
  let closing: Promise<void> | undefined
  const assertOpen = () => {
    if (closed) throw new CoreError('E_CLOSED', 'Side call invocation scope is closed')
    if (turn === undefined || s.op()?.meta.turn !== turn)
      throw new CoreError('E_REQUEST_FROZEN', 'Side call belongs to another turn', { reason: 'foreign' })
  }
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    // Register before the first asynchronous boundary, including effect admission and preparation.
    const promise = Promise.resolve().then(() => {
      assertOpen()
      return work()
    })
    pending.add(promise)
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    )
    return promise
  }
  return Object.freeze<ScopedSideCallPort>({
    prepare: (options) =>
      track(async () => {
        const prepared = await port.prepare({
          ...options,
          invocationId: namespacedInvocationId(scope.caller, options?.invocationId ?? s.d.ids.effectId()),
        })
        assertOpen()
        return prepared
      }),
    invoke: (prepared, signal) =>
      track(() => {
        if (!(signal instanceof AbortSignal))
          throw new CoreError('E_ENVELOPE', 'Side call signal must be an AbortSignal', { reason: 'signal' })
        return port.invoke(prepared, AbortSignal.any([signal, controller.signal]))
      }),
    status: (id) => track(() => port.status(namespacedInvocationId(scope.caller, id))),
    close() {
      if (!closing) {
        closed = true
        controller.abort()
        closing = Promise.allSettled([...pending]).then(() => undefined)
      }
      return closing
    },
  })
}

/** A session-bound factory still creates a fresh scope for every hook invocation. */
export function hookSideCallFactory(session: SessionImpl) {
  return (caller: string) =>
    createScopedSideCallPort(session, { caller, kind: 'hook', scopeId: session.d.ids.effectId() })
}

/** Tool authorization and caller identity are taken only from registered Host metadata. */
export function toolSideCallPort(session: SessionImpl, source: ToolSource, scopeId: string) {
  return source.sideCall && source.pluginRowId
    ? createScopedSideCallPort(session, { caller: source.pluginRowId, kind: 'tool', scopeId })
    : undefined
}

export { createSessionWorkSideCall } from './background-side-call.js'
