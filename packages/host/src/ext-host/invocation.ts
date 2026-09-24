import { AsyncLocalStorage } from 'node:async_hooks'
import { type ProjectionRegistry, type SessionImpl, scanAll } from '@agnes/core'
import { ExtensionError, type SessionRef } from '@agnes/extension-api'
import type { ExtensionActivationBarrier } from './activation-barrier.js'
import type { KernelPorts, RegMeta } from './ports.js'

export type SessionResolver = (ref: SessionRef) => SessionImpl | undefined

type Invocation = { session: SessionImpl; signal: AbortSignal; active: boolean; owner?: string }
const refused = (message: string) => new ExtensionError('E_EVENT_NAMESPACE', message)

/** Runtime-owned session identity; no extension API accepts a session selector. */
export class ExtensionInvocation {
  private readonly current = new AsyncLocalStorage<Invocation>()

  constructor(private readonly activationBarrier?: ExtensionActivationBarrier) {}

  runFor<T>(
    ref: SessionRef,
    signal: AbortSignal,
    resolve: SessionResolver,
    invoke: (session: SessionImpl) => T,
    owner?: string,
  ) {
    const session = resolve(ref)
    if (!session || session.key !== ref.key || session.lane !== ref.lane)
      throw refused('extension callback session unavailable')
    return this.run(session, signal, () => invoke(session), owner)
  }

  run<T>(
    session: SessionImpl,
    signal: AbortSignal,
    invoke: () => T,
    owner?: string,
  ): T | Promise<Awaited<T>> {
    if (signal.aborted) throw refused('extension invocation is cancelled')
    const admitted = this.activationBarrier?.admit('tool')
    const invocation = { session, signal, active: true, ...(owner ? { owner } : {}) }
    const run = () =>
      this.current.run(invocation, () => {
        try {
          const value = invoke()
          const then =
            value && (typeof value === 'object' || typeof value === 'function')
              ? (value as { then?: unknown }).then
              : undefined
          if (typeof then === 'function') {
            return new Promise<Awaited<T>>((resolve, reject) => {
              Reflect.apply(then, value, [resolve, reject])
            }).finally(() => {
              invocation.active = false
            })
          }
          invocation.active = false
          return value
        } catch (error) {
          invocation.active = false
          throw error
        }
      })
    return admitted ? admitted.run(run) : run()
  }

  async readProjection(registry: ProjectionRegistry, key: string, meta: RegMeta, beforeFold: () => void) {
    const invocation = this.current.getStore()
    const valid = () =>
      invocation?.active &&
      !invocation.signal.aborted &&
      !invocation.session.closingOrClosed &&
      invocation.owner === meta.source &&
      key.startsWith(`${meta.source}/`)
    if (!invocation || !valid()) throw new ExtensionError('E_PROJECTION_STATE', 'projection unavailable')
    const asOfSeq = invocation.session.lastSeq
    const rows = await scanAll((q) => invocation.session.scan(q), { toSeq: asOfSeq })
    if (!valid()) throw new ExtensionError('E_PROJECTION_STATE', 'projection unavailable')
    beforeFold()
    const failures = registry.failures().length
    const unit = registry.snapshotOne(invocation.session.key, key, rows, asOfSeq)
    if (registry.failures().length > failures)
      await invocation.session.diag('projection-failed', { key, asOfSeq })
    return { asOfSeq, unit }
  }

  append: KernelPorts['extEvents']['append'] = (type, data, meta: RegMeta) => {
    const invocation = this.current.getStore()
    if (!invocation?.active || invocation.signal.aborted)
      throw refused('extension event has no active session')
    try {
      return invocation.session.appendExtensionEvent(type, data, meta).catch(() => {
        throw refused('extension event write failed')
      })
    } catch {
      throw refused('extension event write failed')
    }
  }
}
