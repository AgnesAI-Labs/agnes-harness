import { AsyncLocalStorage } from 'node:async_hooks'

const permitBrand: unique symbol = Symbol('agnes.activation-permit')
const invocationBrand: unique symbol = Symbol('agnes.activation-invocation')

export type ActivationPermit = Readonly<{ [permitBrand]: true }>
export type ActivationInvocationKind = 'turn' | 'tool' | 'service'

export type ActivationBarrierSnapshot = Readonly<{
  state: 'accepting' | 'quiescing' | 'switching'
  operationId?: string
  active: Readonly<Record<ActivationInvocationKind, number>>
  queued: Readonly<Record<ActivationInvocationKind, number>>
}>

export class ActivationInProgressError extends Error {
  override readonly name = 'ActivationInProgressError'
  readonly code = 'OVERLOADED'
  readonly reason = 'activation-in-progress'
  readonly retryable = true

  constructor(readonly operationId: string) {
    super('activation-in-progress')
  }
}

export class ActivationTimeoutError extends Error {
  override readonly name = 'ActivationTimeoutError'
  readonly code = 'ACTIVATION_TIMEOUT'

  constructor(
    readonly operationId: string,
    readonly deadlineMs: number,
  ) {
    super(`activation ${operationId} did not quiesce within ${deadlineMs}ms`)
  }
}

export class ActivationInvocationCancelledError extends Error {
  override readonly name = 'ActivationInvocationCancelledError'
  readonly code = 'INVOCATION_CANCELLED'

  constructor() {
    super('queued activation invocation was cancelled')
  }
}

export interface ActivationInvocation {
  readonly kind: ActivationInvocationKind
  /** Admit work belonging to this already-running invocation while the global gate is closed. */
  child(kind: Exclude<ActivationInvocationKind, 'turn'>): ActivationInvocation
  /** Hold this invocation kind beyond the current callback while preserving admission ancestry. */
  retain(): ActivationInvocation
  finish(): void
  run<T>(invoke: () => T): T | Promise<Awaited<T>>
}

export interface QueuedActivationInvocation {
  readonly kind: ActivationInvocationKind
  /** Waits behind an activation that started after this item was queued. */
  start(): Promise<ActivationInvocation>
  cancel(): void
}

export interface ExtensionActivationBarrier {
  /** Immediate admission. Wire requests use this so activation produces a retryable refusal. */
  admit(kind: ActivationInvocationKind): ActivationInvocation
  /** Reserve queue position without allowing the invocation to cross a later activation point. */
  enqueue(kind: ActivationInvocationKind): QueuedActivationInvocation
  quiesce<T>(operationId: string, run: (permit: ActivationPermit) => Promise<T>): Promise<T>
  snapshot(): ActivationBarrierSnapshot
}

type GateWaiter = { resolve(): void }

export function createExtensionActivationBarrier(
  options: { deadlineMs?: number } = {},
): ExtensionActivationBarrier {
  const deadlineMs = options.deadlineMs ?? 30_000
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new TypeError('deadlineMs must be positive')

  let state: ActivationBarrierSnapshot['state'] = 'accepting'
  let operationId: string | undefined
  const counts: Record<ActivationInvocationKind, number> = { turn: 0, tool: 0, service: 0 }
  const queued: Record<ActivationInvocationKind, number> = { turn: 0, tool: 0, service: 0 }
  const activeInvocations = new WeakSet<object>()
  const invocationContext = new AsyncLocalStorage<ActivationInvocation>()
  const quiescenceWaiters = new Set<() => void>()
  const gateWaiters = new Set<GateWaiter>()

  const activeCount = () => counts.turn + counts.tool + counts.service
  const signalQuiescence = () => {
    if (activeCount() !== 0) return
    for (const resolve of [...quiescenceWaiters]) resolve()
  }
  const makeInvocation = (kind: ActivationInvocationKind): ActivationInvocation => {
    counts[kind]++
    let active = true
    const identity = Object.freeze({ [invocationBrand]: true })
    activeInvocations.add(identity)
    const assertActive = () => {
      if (!active || !activeInvocations.has(identity))
        throw new TypeError('activation invocation is finished')
    }
    const finish = () => {
      if (!active) return
      active = false
      activeInvocations.delete(identity)
      counts[kind]--
      signalQuiescence()
    }
    let invocation: ActivationInvocation
    invocation = Object.freeze({
      kind,
      child(childKind: Exclude<ActivationInvocationKind, 'turn'>) {
        assertActive()
        return makeInvocation(childKind)
      },
      retain() {
        assertActive()
        return makeInvocation(kind)
      },
      finish,
      run<T>(invoke: () => T): T | Promise<Awaited<T>> {
        assertActive()
        return invocationContext.run(invocation, () => {
          try {
            const value = invoke()
            const then =
              value && (typeof value === 'object' || typeof value === 'function')
                ? (value as { then?: unknown }).then
                : undefined
            if (typeof then === 'function') {
              return new Promise<Awaited<T>>((resolve, reject) => {
                Reflect.apply(then, value, [resolve, reject])
              }).finally(finish)
            }
            finish()
            return value
          } catch (error) {
            finish()
            throw error
          }
        })
      },
    })
    return invocation
  }
  const waitForOpenGate = () => {
    if (state === 'accepting') return Promise.resolve()
    return new Promise<void>((resolve) => gateWaiters.add({ resolve }))
  }
  const openGate = () => {
    state = 'accepting'
    operationId = undefined
    for (const waiter of [...gateWaiters]) {
      gateWaiters.delete(waiter)
      waiter.resolve()
    }
  }
  const waitForQuiescence = () => {
    if (activeCount() === 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        quiescenceWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        quiescenceWaiters.delete(done)
        reject(new ActivationTimeoutError(operationId as string, deadlineMs))
      }, deadlineMs)
      timer.unref?.()
      quiescenceWaiters.add(done)
    })
  }

  return Object.freeze({
    admit(kind: ActivationInvocationKind) {
      const parent = invocationContext.getStore()
      // An already-admitted turn may retain a second turn reference for durable continuation.
      // This is not a fresh admission: it is part of the same causal invocation and therefore may
      // cross a gate that closed after the parent started. Unrelated/nested turn requests still
      // have no invocation context and are refused below while quiescing.
      if (parent?.kind === 'turn' && kind === 'turn') {
        try {
          return parent.retain()
        } catch (error) {
          if (!(error instanceof TypeError)) throw error
          // AsyncLocalStorage may outlive the invocation in detached work. An expired parent is
          // not authority to cross the gate; treat this as an unrelated fresh admission below.
        }
      }
      if (parent && kind !== 'turn') return parent.child(kind)
      if (state !== 'accepting') throw new ActivationInProgressError(operationId as string)
      return makeInvocation(kind)
    },
    enqueue(kind: ActivationInvocationKind) {
      if (state !== 'accepting') throw new ActivationInProgressError(operationId as string)
      queued[kind]++
      let status: 'queued' | 'starting' | 'started' | 'cancelled' = 'queued'
      let cancelled = false
      return Object.freeze({
        kind,
        async start() {
          if (status !== 'queued') {
            if (status === 'cancelled') throw new ActivationInvocationCancelledError()
            throw new TypeError('queued activation invocation already started')
          }
          status = 'starting'
          if (state === 'accepting') {
            status = 'started'
            queued[kind]--
            return makeInvocation(kind)
          }
          await waitForOpenGate()
          if (cancelled) throw new ActivationInvocationCancelledError()
          status = 'started'
          queued[kind]--
          return makeInvocation(kind)
        },
        cancel() {
          if (status === 'started' || status === 'cancelled') return
          cancelled = true
          status = 'cancelled'
          queued[kind]--
        },
      })
    },
    async quiesce<T>(nextOperationId: string, run: (permit: ActivationPermit) => Promise<T>) {
      if (!nextOperationId) throw new TypeError('operationId is required')
      if (state !== 'accepting') throw new ActivationInProgressError(operationId as string)
      state = 'quiescing'
      operationId = nextOperationId
      try {
        await waitForQuiescence()
        state = 'switching'
        const permit = Object.freeze({ [permitBrand]: true }) as ActivationPermit
        return await run(permit)
      } finally {
        openGate()
      }
    },
    snapshot() {
      return Object.freeze({
        state,
        ...(operationId ? { operationId } : {}),
        active: Object.freeze({ ...counts }),
        queued: Object.freeze({ ...queued }),
      })
    },
  })
}
