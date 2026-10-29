export type ResourceGenerationCleanup = () => void | Promise<void>

export type ResourceGenerationCandidateScope = Readonly<{
  /** Register generation-owned cleanup in construction order. Retirement runs it in reverse. */
  defer(cleanup: ResourceGenerationCleanup): void
}>

export type ResourceGenerationLease<Value> = Readonly<{
  value: Value
  /** Idempotent and synchronous; the last release starts an already-requested retirement. */
  release(): void
}>

export type ResourceGenerationFacade<Value> = Readonly<{
  /** Resolve from one exact generation while synchronously acquiring its invocation lease. */
  acquire(): ResourceGenerationLease<Value>
  run<Result>(invoke: (value: Value) => Result | Promise<Result>): Promise<Result>
}>

type CandidateState = 'prepared' | 'consumed' | 'discarded'

export class ResourceGenerationError extends Error {
  constructor(
    readonly code:
      | 'E_RESOURCE_GENERATION_OWNER'
      | 'E_RESOURCE_GENERATION_CONSUMED'
      | 'E_RESOURCE_GENERATION_CURRENT'
      | 'E_RESOURCE_GENERATION_UNAVAILABLE'
      | 'E_RESOURCE_GENERATION_CANDIDATE_CLOSED',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ResourceGenerationError'
  }
}

async function cleanupAll(cleanups: readonly ResourceGenerationCleanup[], primary?: unknown): Promise<void> {
  const failures: unknown[] = []
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    const cleanup = cleanups[index]
    if (!cleanup) continue
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  if (primary !== undefined && failures.length === 0) throw primary
  if (primary !== undefined) {
    throw new AggregateError([primary, ...failures], 'resource generation preparation and cleanup failed')
  }
  if (failures.length > 0) throw new AggregateError(failures, 'resource generation cleanup failed')
}

class CandidateScope implements ResourceGenerationCandidateScope {
  readonly cleanups: ResourceGenerationCleanup[] = []
  #active = true

  defer(cleanup: ResourceGenerationCleanup): void {
    if (!this.#active) {
      throw new ResourceGenerationError(
        'E_RESOURCE_GENERATION_CANDIDATE_CLOSED',
        'candidate cleanup registration is closed',
      )
    }
    if (typeof cleanup !== 'function') throw new TypeError('resource generation cleanup must be a function')
    this.cleanups.push(cleanup)
  }

  close(): void {
    this.#active = false
  }
}

/**
 * An opaque generation stored by the outer RuntimeState. It deliberately exposes no resource value:
 * dispatch must resolve through a stable facade so lease acquisition cannot be skipped.
 */
export class ResourceGeneration<Resources> {
  readonly #owner: object
  readonly #resources: Resources
  readonly #cleanups: readonly ResourceGenerationCleanup[]
  #leases = 0
  #retiring = false
  #retirement: Promise<void> | undefined
  #startRetirement: (() => void) | undefined

  constructor(owner: object, resources: Resources, cleanups: readonly ResourceGenerationCleanup[]) {
    this.#owner = owner
    this.#resources = resources
    this.#cleanups = Object.freeze([...cleanups])
  }

  _acquire<Value>(
    owner: object,
    resolve: (resources: Resources) => Value,
  ): ResourceGenerationLease<Value> | undefined {
    this.#assertOwner(owner)
    if (this.#retiring) return undefined
    this.#leases += 1
    let released = false
    try {
      const value = resolve(this.#resources)
      return Object.freeze({
        value,
        release: () => {
          if (released) return
          released = true
          this.#leases -= 1
          if (this.#leases === 0) this.#startRetirement?.()
        },
      })
    } catch (error) {
      this.#leases -= 1
      if (this.#leases === 0) this.#startRetirement?.()
      throw error
    }
  }

  _retire(owner: object): Promise<void> {
    this.#assertOwner(owner)
    if (this.#retirement) return this.#retirement
    this.#retiring = true
    let resolveRetirement!: () => void
    let rejectRetirement!: (error: unknown) => void
    this.#retirement = new Promise<void>((resolve, reject) => {
      resolveRetirement = resolve
      rejectRetirement = reject
    })
    let started = false
    this.#startRetirement = () => {
      if (started) return
      started = true
      this.#startRetirement = undefined
      void cleanupAll(this.#cleanups).then(resolveRetirement, rejectRetirement)
    }
    if (this.#leases === 0) this.#startRetirement()
    return this.#retirement
  }

  #assertOwner(owner: object): void {
    if (owner !== this.#owner) {
      throw new ResourceGenerationError('E_RESOURCE_GENERATION_OWNER', 'generation belongs to another cell')
    }
  }
}

/** Opaque, one-shot candidate. Only its owning cell can consume or discard it. */
export class ResourceGenerationCandidate<Resources> {
  readonly #owner: object
  readonly #generation: ResourceGeneration<Resources>
  #state: CandidateState = 'prepared'

  constructor(owner: object, generation: ResourceGeneration<Resources>) {
    this.#owner = owner
    this.#generation = generation
  }

  _consume(owner: object): ResourceGeneration<Resources> {
    this.#assertPrepared(owner)
    this.#state = 'consumed'
    return this.#generation
  }

  _discard(owner: object): Promise<void> {
    this.#assertPrepared(owner)
    this.#state = 'discarded'
    return this.#generation._retire(owner)
  }

  #assertPrepared(owner: object): void {
    if (owner !== this.#owner) {
      throw new ResourceGenerationError('E_RESOURCE_GENERATION_OWNER', 'candidate belongs to another cell')
    }
    if (this.#state !== 'prepared') {
      throw new ResourceGenerationError(
        'E_RESOURCE_GENERATION_CONSUMED',
        `candidate is already ${this.#state}`,
      )
    }
  }
}

/**
 * Owns resource generation candidates, leases, and retirement, but never owns the live pointer.
 * `currentGeneration` must read the one outer RuntimeState pointer. `acquire()` uses a
 * getter→lease→getter loop, so it is safe on its own; callers may additionally hold PublicationGate's
 * dispatch ticket across this synchronous method as required by the composite publication path.
 */
export class ResourceGenerationCell<Resources> {
  readonly #owner = Object.freeze({})
  readonly #currentGeneration: () => ResourceGeneration<Resources> | undefined
  readonly #retirements = new Set<Promise<void>>()
  readonly #retirementFailures = new Map<Promise<void>, unknown>()

  constructor(currentGeneration: () => ResourceGeneration<Resources> | undefined) {
    this.#currentGeneration = currentGeneration
  }

  async prepare(
    build: (scope: ResourceGenerationCandidateScope) => Resources | Promise<Resources>,
    health?: (resources: Resources, scope: ResourceGenerationCandidateScope) => void | Promise<void>,
  ): Promise<ResourceGenerationCandidate<Resources>> {
    const scope = new CandidateScope()
    try {
      const resources = await build(scope)
      await health?.(resources, scope)
      scope.close()
      return new ResourceGenerationCandidate(
        this.#owner,
        new ResourceGeneration(this.#owner, resources, scope.cleanups),
      )
    } catch (error) {
      scope.close()
      await cleanupAll(scope.cleanups, error)
      throw new Error('unreachable resource generation preparation failure')
    }
  }

  /**
   * Validate owner and one-shot use before the outer RuntimeState exchange. This method has no await
   * and does not alter any live pointer; the caller must immediately place the result in its single
   * atomic RuntimeState exchange.
   */
  consumeCandidate(candidate: ResourceGenerationCandidate<Resources>): ResourceGeneration<Resources> {
    return candidate._consume(this.#owner)
  }

  async discardCandidate(candidate: ResourceGenerationCandidate<Resources>): Promise<void> {
    await candidate._discard(this.#owner)
  }

  /** Retire an old generation. The generation currently named by RuntimeState always fails closed. */
  retire(generation: ResourceGeneration<Resources> | undefined): Promise<void> {
    if (!generation) return Promise.resolve()
    if (this.#currentGeneration() === generation) {
      throw new ResourceGenerationError(
        'E_RESOURCE_GENERATION_CURRENT',
        'the current RuntimeState generation cannot be retired',
      )
    }
    const retirement = generation._retire(this.#owner)
    this.#retirements.add(retirement)
    void retirement.then(
      () => this.#retirements.delete(retirement),
      (error) => {
        this.#retirements.delete(retirement)
        this.#retirementFailures.set(retirement, error)
      },
    )
    return retirement
  }

  createFacade<Value>(resolve: (resources: Resources) => Value): ResourceGenerationFacade<Value> {
    const acquire = (): ResourceGenerationLease<Value> => {
      while (true) {
        const generation = this.#currentGeneration()
        if (!generation) {
          throw new ResourceGenerationError(
            'E_RESOURCE_GENERATION_UNAVAILABLE',
            'RuntimeState has no current resource generation',
          )
        }
        const lease = generation._acquire(this.#owner, resolve)
        if (!lease) continue
        if (this.#currentGeneration() === generation) return lease
        lease.release()
      }
    }
    return Object.freeze({
      acquire,
      async run<Result>(invoke: (value: Value) => Result | Promise<Result>): Promise<Result> {
        const lease = acquire()
        try {
          return await invoke(lease.value)
        } finally {
          lease.release()
        }
      },
    })
  }

  /** Wait for the retire queue visible at call time; useful during Host shutdown. */
  async drainRetirements(): Promise<void> {
    const active = [...this.#retirements]
    const completedFailures = [...this.#retirementFailures.entries()]
    const settled = await Promise.allSettled(active)
    for (const [retirement] of completedFailures) this.#retirementFailures.delete(retirement)
    for (const retirement of active) this.#retirementFailures.delete(retirement)
    const failures = [
      ...completedFailures.map(([, error]) => error),
      ...settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
    ].filter((failure, index, all) => all.indexOf(failure) === index)
    if (failures.length > 0) throw new AggregateError(failures, 'resource generation retirement failed')
  }
}
