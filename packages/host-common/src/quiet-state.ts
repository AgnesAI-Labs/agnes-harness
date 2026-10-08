import type { QuietGate } from '@agnes/core'

export type ReconcilePoint = 'immediate' | 'step' | 'turn'

export type QuietWaitResult = 'quiet' | 'timeout'

type Boundary = 'step' | 'turn'
type GroupState = { active: number; boundary?: Boundary }
type QuietWaiter = {
  point: Exclude<ReconcilePoint, 'immediate'>
  resolve(result: QuietWaitResult): void
  timer?: ReturnType<typeof setTimeout>
}

function accepts(point: QuietWaiter['point'], boundary: Boundary): boolean {
  return point === 'step' || boundary === 'turn'
}

/**
 * Host-owned quiet coordinator. Independent root sessions stop at qualifying yields while a
 * reconcile waiter exists; descendants share their root group and therefore cannot deadlock a
 * parent that is synchronously awaiting them.
 */
export class HostQuietState implements QuietGate {
  readonly #groups = new Map<string, GroupState>()
  #waiters: QuietWaiter[] = []
  #barrier: { promise: Promise<void>; release(): void } | undefined
  #admitted = false

  get stepping(): number {
    let total = 0
    for (const group of this.#groups.values()) total += group.active
    return total
  }

  enter(groupKey: string): Promise<void> | void {
    const group = this.#groups.get(groupKey) ?? { active: 0 }
    this.#groups.set(groupKey, group)
    const activate = (): void => {
      delete group.boundary
      group.active += 1
    }
    // A nested child shares an already-active root group and must be allowed through; a fresh root
    // or a root trying to leave its held boundary waits until the reconcile transaction releases it.
    if (group.active === 0 && this.#barrier) return this.#barrier.promise.then(activate)
    activate()
  }

  leave(groupKey: string): void {
    const group = this.#groups.get(groupKey)
    if (!group || group.active === 0) throw new Error('E_QUIET_GATE_UNBALANCED: leave without matching enter')
    group.active -= 1
  }

  yieldPoint(kind: Boundary, groupKey: string): Promise<void> {
    const group = this.#groups.get(groupKey) ?? { active: 0 }
    this.#groups.set(groupKey, group)
    // A descendant yielded while its parent still executes in the same group. Holding it here would
    // prevent the parent from ever reaching its own boundary.
    if (group.active !== 0) return Promise.resolve()
    group.boundary = kind

    const relevant = this.#waiters.some((waiter) => accepts(waiter.point, kind))
    if (relevant) this.#ensureBarrier()
    this.#admitEligible()
    return relevant || this.#admitted ? (this.#barrier?.promise ?? Promise.resolve()) : Promise.resolve()
  }

  /** Runs one reconcile transaction while every qualifying independent group remains at its yield. */
  async withBoundary<T>(
    point: ReconcilePoint,
    maxWaitMs: number | undefined,
    transaction: (result: QuietWaitResult) => Promise<T>,
  ): Promise<T> {
    if (point === 'immediate') return transaction('quiet')
    const result = await this.#wait(point, maxWaitMs)
    try {
      return await transaction(result)
    } finally {
      if (result === 'quiet') this.#admitted = false
      this.#releaseBarrierIfIdle()
    }
  }

  #wait(point: Exclude<ReconcilePoint, 'immediate'>, maxWaitMs?: number): Promise<QuietWaitResult> {
    if (this.#isEligible(point)) {
      this.#ensureBarrier()
      this.#admitted = true
      return Promise.resolve('quiet')
    }
    return new Promise<QuietWaitResult>((resolve) => {
      const waiter: QuietWaiter = {
        point,
        resolve,
        ...(maxWaitMs === undefined
          ? {}
          : {
              timer: setTimeout(() => {
                this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter)
                resolve('timeout')
                this.#releaseBarrierIfIdle()
              }, maxWaitMs),
            }),
      }
      this.#waiters.push(waiter)
    })
  }

  #isEligible(point: QuietWaiter['point']): boolean {
    for (const group of this.#groups.values()) {
      if (group.active !== 0 || !group.boundary || !accepts(point, group.boundary)) return false
    }
    return true
  }

  #admitEligible(): void {
    if (this.#admitted) return
    const index = this.#waiters.findIndex((waiter) => this.#isEligible(waiter.point))
    if (index < 0) return
    const [waiter] = this.#waiters.splice(index, 1)
    if (!waiter) return
    if (waiter.timer) clearTimeout(waiter.timer)
    this.#ensureBarrier()
    this.#admitted = true
    waiter.resolve('quiet')
  }

  #ensureBarrier(): void {
    if (this.#barrier) return
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#barrier = { promise, release }
  }

  #releaseBarrierIfIdle(): void {
    if (this.#admitted || this.#waiters.length) return
    const barrier = this.#barrier
    this.#barrier = undefined
    barrier?.release()
  }
}
