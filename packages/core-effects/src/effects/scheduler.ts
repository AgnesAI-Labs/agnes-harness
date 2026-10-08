export type BatchCall<T> = { ordinal: number; concurrencySafe: boolean; run(): Promise<T> }

export class NestedToolSchedulingError extends Error {
  constructor(readonly reason: 'aborted' | 'closed') {
    super(reason === 'aborted' ? 'aborted: nested tool scheduling' : 'nested tool parent lease is closed')
    this.name = 'NestedToolSchedulingError'
  }
}

export type NestedToolLease = {
  readonly concurrencySafe: boolean
  active: boolean
}

type NestedWaiter = {
  lease: NestedToolLease
  admit(): void
  cancel(error: Error): void
}

type LeaseState = {
  parent?: NestedToolLease
  exclusiveRoot: boolean
  ownsGlobalAdmission: boolean
  closing: boolean
  closed: boolean
  suspendCount: number
  activeWaiters: Array<() => void>
  children: AdmissionQueue
}

type AdmissionWaiter = {
  concurrencySafe: boolean
  start(): void
  cancel(error: Error): void
}

/** A fair dynamic safe-run/unsafe-barrier queue used for siblings in one invocation context. */
class AdmissionQueue {
  private readonly waiting: AdmissionWaiter[] = []
  private readonly drainWaiters: Array<() => void> = []
  private activeSafe = 0
  private activeUnsafe = false
  private outstanding = 0

  run<T>(concurrencySafe: boolean, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.outstanding++
    return new Promise<T>((resolve, reject) => {
      let started = false
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
        waiter.cancel(new NestedToolSchedulingError('aborted'))
        this.pump()
      }
      const waiter: AdmissionWaiter = {
        concurrencySafe,
        start: () => {
          started = true
          signal?.removeEventListener('abort', onAbort)
          const finish = (): void => {
            if (concurrencySafe) this.activeSafe--
            else this.activeUnsafe = false
            this.outstanding--
            this.pump()
            if (this.outstanding === 0) for (const drained of this.drainWaiters.splice(0)) drained()
          }
          void Promise.resolve().then(run).then(resolve, reject).finally(finish)
        },
        cancel: (error) => {
          if (started) return
          signal?.removeEventListener('abort', onAbort)
          this.outstanding--
          reject(error)
          if (this.outstanding === 0) for (const drained of this.drainWaiters.splice(0)) drained()
        },
      }
      this.waiting.push(waiter)
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      this.pump()
    })
  }

  async drain(): Promise<void> {
    if (this.outstanding === 0) return
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve))
  }

  private pump(): void {
    if (this.activeUnsafe || this.waiting.length === 0) return
    if (this.activeSafe > 0 && !this.waiting[0]?.concurrencySafe) return
    if (!this.waiting[0]?.concurrencySafe) {
      const next = this.waiting.shift()
      if (!next) return
      this.activeUnsafe = true
      next.start()
      return
    }
    while (this.waiting[0]?.concurrencySafe) {
      const next = this.waiting.shift()
      if (!next) return
      this.activeSafe++
      next.start()
    }
  }
}

/**
 * Coordinates root and child tool calls in one hierarchy. Safe siblings may overlap. An unsafe
 * descendant temporarily suspends every safe lease in its ancestor chain, then runs as the global
 * barrier; shared ancestors use a suspension count so two branches upgrading together cannot
 * prematurely resume one another. Descendants of an unsafe lease stay inside that exclusive root.
 */
export class NestedToolScheduler {
  private readonly waiting: NestedWaiter[] = []
  private readonly states = new WeakMap<NestedToolLease, LeaseState>()
  private activeSafe = 0
  private activeUnsafe = false

  async run<T>(
    concurrencySafe: boolean,
    run: (lease: NestedToolLease) => Promise<T>,
    parent?: NestedToolLease,
    signal?: AbortSignal,
  ): Promise<T> {
    if (parent) {
      const state = this.state(parent)
      if (state.closing || state.closed) throw new NestedToolSchedulingError('closed')
      return state.children.run(
        concurrencySafe,
        () => this.runChild(concurrencySafe, run, parent, signal),
        signal,
      )
    }
    const lease = await this.acquire(concurrencySafe, undefined, !concurrencySafe, signal)
    try {
      return await run(lease)
    } finally {
      await this.close(lease)
    }
  }

  private async runChild<T>(
    concurrencySafe: boolean,
    run: (lease: NestedToolLease) => Promise<T>,
    parent: NestedToolLease,
    signal?: AbortSignal,
  ): Promise<T> {
    const parentState = this.state(parent)
    if (parentState.exclusiveRoot) {
      const lease = this.inheritedLease(concurrencySafe, parent)
      try {
        return await run(lease)
      } finally {
        await this.close(lease)
      }
    }
    if (concurrencySafe) {
      const lease = await this.acquire(true, parent, false, signal)
      try {
        return await run(lease)
      } finally {
        await this.close(lease)
      }
    }

    const ancestors = this.safeAncestors(parent)
    for (const lease of ancestors) this.suspend(lease)
    let lease: NestedToolLease
    try {
      lease = await this.acquire(false, parent, true, signal)
    } catch (error) {
      await Promise.all(ancestors.map((ancestor) => this.resume(ancestor)))
      throw error
    }
    try {
      return await run(lease)
    } finally {
      await this.close(lease)
      await Promise.all(ancestors.map((ancestor) => this.resume(ancestor)))
    }
  }

  private acquire(
    concurrencySafe: boolean,
    parent: NestedToolLease | undefined,
    exclusiveRoot: boolean,
    signal?: AbortSignal,
  ): Promise<NestedToolLease> {
    const lease: NestedToolLease = { concurrencySafe, active: false }
    this.states.set(lease, {
      ...(parent ? { parent } : {}),
      exclusiveRoot,
      ownsGlobalAdmission: true,
      closing: false,
      closed: false,
      suspendCount: 0,
      activeWaiters: [],
      children: new AdmissionQueue(),
    })
    return this.enqueue(lease, signal)
  }

  private inheritedLease(concurrencySafe: boolean, parent: NestedToolLease): NestedToolLease {
    const lease: NestedToolLease = { concurrencySafe, active: true }
    this.states.set(lease, {
      parent,
      exclusiveRoot: true,
      ownsGlobalAdmission: false,
      closing: false,
      closed: false,
      suspendCount: 0,
      activeWaiters: [],
      children: new AdmissionQueue(),
    })
    return lease
  }

  private safeAncestors(parent: NestedToolLease): NestedToolLease[] {
    const ancestors: NestedToolLease[] = []
    let current: NestedToolLease | undefined = parent
    while (current) {
      const state = this.state(current)
      if (state.exclusiveRoot) break
      ancestors.push(current)
      current = state.parent
    }
    return ancestors
  }

  private suspend(lease: NestedToolLease): void {
    const state = this.state(lease)
    state.suspendCount++
    if (state.suspendCount === 1) this.release(lease)
  }

  private async resume(lease: NestedToolLease): Promise<void> {
    const state = this.state(lease)
    if (state.suspendCount < 1) throw new Error('nested tool lease is not suspended')
    state.suspendCount--
    if (state.suspendCount === 0) {
      await this.enqueue(lease)
      for (const resolve of state.activeWaiters.splice(0)) resolve()
      return
    }
    await new Promise<void>((resolve) => state.activeWaiters.push(resolve))
  }

  private state(lease: NestedToolLease): LeaseState {
    const state = this.states.get(lease)
    if (!state) throw new Error('unknown nested tool lease')
    return state
  }

  private async close(lease: NestedToolLease): Promise<void> {
    const state = this.state(lease)
    if (state.closed) throw new Error('nested tool lease is already closed')
    state.closing = true
    await state.children.drain()
    if (state.suspendCount > 0) await new Promise<void>((resolve) => state.activeWaiters.push(resolve))
    if (state.ownsGlobalAdmission) this.release(lease)
    else lease.active = false
    state.closed = true
  }

  private enqueue(lease: NestedToolLease, signal?: AbortSignal): Promise<NestedToolLease> {
    if (lease.active) throw new Error('nested tool lease is already active')
    return new Promise((resolve, reject) => {
      let admitted = false
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
        waiter.cancel(new NestedToolSchedulingError('aborted'))
        this.pump()
      }
      const waiter: NestedWaiter = {
        lease,
        admit: () => {
          admitted = true
          signal?.removeEventListener('abort', onAbort)
          lease.active = true
          resolve(lease)
        },
        cancel: (error) => {
          if (admitted) return
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      this.waiting.push(waiter)
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      this.pump()
    })
  }

  private release(lease: NestedToolLease): void {
    if (!lease.active) throw new Error('nested tool lease is not active')
    lease.active = false
    if (lease.concurrencySafe) this.activeSafe--
    else this.activeUnsafe = false
    this.pump()
  }

  private pump(): void {
    if (this.activeUnsafe || this.waiting.length === 0) return
    if (this.activeSafe > 0 && !this.waiting[0]?.lease.concurrencySafe) return
    if (!this.waiting[0]?.lease.concurrencySafe) {
      const next = this.waiting.shift()
      if (!next) return
      this.activeUnsafe = true
      next.admit()
      return
    }
    while (this.waiting[0]?.lease.concurrencySafe) {
      const next = this.waiting.shift()
      if (!next) return
      this.activeSafe++
      next.admit()
    }
  }
}

/**
 * Runs one batch of tool calls the way the model asked for them: a run of concurrency-safe calls
 * goes out together under a bounded pool, and a call that is not concurrency safe is a barrier — it
 * starts only once everything before it has finished, and nothing after it starts until it has.
 * Results come back in ordinal order regardless of completion order, because that is the order the
 * conversation records them in.
 *
 * Abort stops what has not started; what is already running is awaited rather than abandoned, so no
 * result is invented for a call whose side effect may still land.
 */
export async function scheduleBatch<T>(
  calls: BatchCall<T>[],
  opts: { maxParallel: number; signal: AbortSignal; onSkipped(call: BatchCall<T>): T },
): Promise<T[]> {
  const sorted = [...calls].sort((a, b) => a.ordinal - b.ordinal)
  const results = new Array<T>(sorted.length)
  let i = 0
  while (i < sorted.length) {
    const c = sorted[i] as BatchCall<T>
    if (opts.signal.aborted) {
      results[i] = opts.onSkipped(c)
      i++
      continue
    }
    if (!c.concurrencySafe) {
      results[i] = await c.run()
      i++
      continue
    }
    let j = i
    while (j < sorted.length && (sorted[j] as BatchCall<T>).concurrencySafe) j++
    const segment = sorted.slice(i, j)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < segment.length) {
        const idx = next++
        const call = segment[idx] as BatchCall<T>
        // Re-read the signal per call, not once per segment: a call already running can abort the
        // batch, and the calls queued behind it in the same pool must see that.
        results[i + idx] = opts.signal.aborted ? opts.onSkipped(call) : await call.run()
      }
    }
    await Promise.all(Array.from({ length: Math.min(opts.maxParallel, segment.length) }, worker))
    i = j
  }
  return results
}
