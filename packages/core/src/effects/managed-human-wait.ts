import type { ToolContext } from '@agnes/extension-api'
import type { Timers } from '../log/session-log.js'
import { type Clock, CoreError } from '../types.js'

declare const humanWaitScope: unique symbol
/** Opaque ancestry for one live tool attempt; never a tool-facing pause capability. */
export type HumanWaitScope = Readonly<{ [humanWaitScope]: true }>

const contexts = new WeakMap<ToolContext, ManagedToolBudget>()
const scopes = new WeakMap<HumanWaitScope, ManagedToolBudget>()
const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
}

/** Capture inside the trusted nested-invocation adapter, not from extension arguments. */
export function humanWaitParent(context: ToolContext): HumanWaitScope | undefined {
  return contexts.get(context)?.scope
}

/** Trusted preparation reads the execution deadline without pausing ordinary work. */
export function managedHumanWaitSignal(context: ToolContext): AbortSignal | undefined {
  return contexts.get(context)?.signal
}

/**
 * Only the trusted questions service calls this, after validation and durable request admission.
 * Cancellation remains live while ordinary execution time is paused. The actual invocation is
 * still tracked and drained by its owner; a cancelled answer is not proof that a tool exited.
 */
export function withManagedHumanWait<T>(
  context: ToolContext,
  wait: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const budget = contexts.get(context)
  if (!budget)
    return Promise.reject(new CoreError('E_RELATION', 'human wait requires a managed tool attempt'))
  return budget.humanWait(wait)
}

/** Internal dispatch machinery; only the opaque scope and trusted wait wrapper are public. */
export class ManagedToolBudget {
  readonly scope = Object.freeze({}) as HumanWaitScope
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly parent: ManagedToolBudget | undefined
  private readonly timers: Timers
  private readonly clock: Clock
  private readonly terminal: Promise<never>
  private rejectTerminal!: (error: Error) => void
  private remaining: number
  private startedAt: number
  private pauses = 0
  private done = false
  private reason: Error | undefined
  private timerEpoch = 0
  private armed = false
  private handle: unknown
  private readonly onAbort = () => this.end(new Error(`aborted: ${this.options.label}`))

  constructor(
    private readonly options: {
      timeoutMs: number
      label: string
      signal: AbortSignal
      parent?: HumanWaitScope
      timers?: Timers
      monotonicClock?: Clock
    },
  ) {
    this.parent = options.parent ? scopes.get(options.parent) : undefined
    if (options.parent && (!this.parent || this.parent.done))
      throw new CoreError('E_RELATION', 'invalid human wait ancestry')
    this.timers = options.timers ?? defaultTimers
    this.clock = options.monotonicClock ?? (() => performance.now())
    this.remaining = options.timeoutMs
    this.startedAt = this.clock()
    this.signal = this.controller.signal
    this.terminal = new Promise<never>((_resolve, reject) => {
      this.rejectTerminal = reject
    })
    // It may end during synchronous dispatch, before run() installs the observing race.
    void this.terminal.catch(() => undefined)
    scopes.set(this.scope, this)
    if (options.signal.aborted) this.onAbort()
    else {
      options.signal.addEventListener('abort', this.onAbort, { once: true })
      this.arm()
    }
  }

  bind(context: ToolContext): ToolContext {
    const prior = contexts.get(context)
    if (prior && prior !== this && !prior.done)
      throw new CoreError('E_RELATION', 'tool context belongs to another live attempt')
    contexts.set(context, this)
    return context
  }

  run<T>(pending: Promise<T>): Promise<T> {
    return Promise.race([pending, this.terminal])
  }

  close(): void {
    this.end(new Error(`aborted: ${this.options.label}`))
  }

  private clearTimer(): void {
    this.timerEpoch++
    if (this.armed) this.timers.clearTimeout(this.handle)
    this.armed = false
  }

  private arm(): void {
    if (this.done || this.pauses > 0) return
    this.startedAt = this.clock()
    const epoch = ++this.timerEpoch
    const handle = this.timers.setTimeout(() => {
      if (epoch !== this.timerEpoch || this.done || this.pauses > 0) return
      this.end(new Error(`timeout: ${this.options.label}`))
    }, this.remaining)
    if (epoch === this.timerEpoch && !this.done && this.pauses === 0) {
      this.handle = handle
      this.armed = true
    } else this.timers.clearTimeout(handle)
  }

  private end(error: Error): void {
    if (this.done) return
    this.done = true
    this.reason = error
    this.clearTimer()
    this.options.signal.removeEventListener('abort', this.onAbort)
    this.rejectTerminal(error)
    this.controller.abort(error)
  }

  private pause(): () => void {
    if (this.done) throw this.reason
    if (this.pauses === 0) {
      this.remaining -= Math.max(0, this.clock() - this.startedAt)
      this.clearTimer()
      // An overdue timer not yet delivered cannot be rescued by starting a question.
      if (this.remaining <= 0) {
        const error = new Error(`timeout: ${this.options.label}`)
        this.end(error)
        throw error
      }
    }
    this.pauses++
    let released = false
    return () => {
      if (released) return
      released = true
      this.pauses--
      if (!this.done && this.pauses === 0) this.arm()
    }
  }

  async humanWait<T>(wait: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ancestry: ManagedToolBudget[] = []
    for (let budget: ManagedToolBudget | undefined = this; budget; budget = budget.parent)
      ancestry.push(budget)
    const releases: Array<() => void> = []
    try {
      for (const budget of ancestry.toReversed()) releases.push(budget.pause())
      const signal = AbortSignal.any(ancestry.map((budget) => budget.signal))
      signal.throwIfAborted()
      return await new Promise<T>((resolve, reject) => {
        let settled = false
        const finish = (complete: () => void) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', abort)
          complete()
        }
        const abort = () => finish(() => reject(signal.reason))
        signal.addEventListener('abort', abort, { once: true })
        // Install cancellation before invoking the answerer, including synchronous abort/throw.
        try {
          Promise.resolve(wait(signal)).then(
            (value) => finish(() => resolve(value)),
            (error: unknown) => finish(() => reject(error)),
          )
        } catch (error) {
          finish(() => reject(error))
        }
      })
    } finally {
      for (const release of releases.toReversed()) release()
    }
  }
}
