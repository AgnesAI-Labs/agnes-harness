import type { PublicationGate } from './publication-gate.js'
import type { CandidateRuntime } from './runtime-candidate.js'
import { RuntimeMutationGate, type RuntimeReadLease } from './runtime-mutation-gate.js'

export type RuntimeStateSnapshot<T extends object> = Readonly<{
  epoch: number
  value: T
}>

export type RuntimeStateCandidateBuilder<T extends object> = (
  base: RuntimeStateSnapshot<T>,
) => CandidateRuntime<T> | Promise<CandidateRuntime<T>>

export type RuntimeStateCoordinatorOptions<T extends object> = Readonly<{
  initial: T
  publication: PublicationGate
  /** Serializes the runtime activation/retirement boundary without enclosing PublicationGate work. */
  mutation?: RuntimeMutationGate
  /** Runs after publication reopens. It owns retirement of every handle reachable only from old. */
  retire(previous: T, current: T): void | Promise<void>
  maxRetries?: number
}>

export type RuntimeStatePublishOptions<T extends object> = Readonly<{
  /** Host-only invariant check. It runs after dispatch drains and must never dispatch plugin/user code. */
  precommit?: (candidate: T, base: RuntimeStateSnapshot<T>) => void | Promise<void>
}>

export class RuntimeStateStaleError extends Error {
  readonly code = 'E_RUNTIME_STATE_STALE'

  constructor(attempts: number) {
    super(`runtime state changed during candidate construction ${attempts} times`)
    this.name = 'RuntimeStateStaleError'
  }
}

/**
 * The Host's sole live runtime pointer. Candidate construction and validation happen while
 * dispatch remains open. PublicationGate closes for the epoch check, Host-owned precommit invariant,
 * and synchronous candidate commit/pointer exchange. Cleanup and plugin/user dispatch stay outside it.
 */
export class RuntimeStateCoordinator<T extends object> {
  readonly #publication: PublicationGate
  readonly #mutation: RuntimeMutationGate
  readonly #retire: RuntimeStateCoordinatorOptions<T>['retire']
  readonly #maxRetries: number
  readonly #retirements = new Set<Promise<void>>()
  readonly #retirementFailures: unknown[] = []
  #current: T
  #epoch = 1

  constructor(options: RuntimeStateCoordinatorOptions<T>) {
    const maxRetries = options.maxRetries ?? 8
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 1) {
      throw new TypeError('maxRetries must be a positive safe integer')
    }
    this.#current = options.initial
    this.#publication = options.publication
    this.#mutation = options.mutation ?? new RuntimeMutationGate()
    this.#retire = options.retire
    this.#maxRetries = maxRetries
  }

  current(): RuntimeStateSnapshot<T> {
    return Object.freeze({ epoch: this.#epoch, value: this.#current })
  }

  enterRead(signal?: AbortSignal): Promise<RuntimeReadLease> {
    return this.#mutation.enterRead(signal)
  }

  withRead<TValue>(
    callback: (lease: RuntimeReadLease) => TValue | PromiseLike<TValue>,
    signal?: AbortSignal,
  ): Promise<TValue> {
    return this.#mutation.withRead(callback, signal)
  }

  async publish(
    build: RuntimeStateCandidateBuilder<T>,
    options: RuntimeStatePublishOptions<T> = {},
  ): Promise<RuntimeStateSnapshot<T>> {
    for (let attempt = 1; attempt <= this.#maxRetries; attempt += 1) {
      const base = this.current()
      const candidate = await build(base)
      let committed = false
      let stale = false
      let previous: T | undefined
      let current: T | undefined
      try {
        await this.#mutation.mutate(async () => {
          await this.#publication.withClosed(async () => {
            if (this.#epoch !== base.epoch || this.#current !== base.value) {
              stale = true
              return
            }
            if (options.precommit) {
              await candidate.precommit((value) => options.precommit?.(value, base))
            }
            // CandidateRuntime.commit() is deliberately synchronous and callback-free.
            const next = candidate.commit()
            previous = this.#current
            this.#current = next
            this.#epoch += 1
            current = next
            committed = true
          })
        })
      } catch (error) {
        if (!committed) {
          try {
            await this.#mutation.mutate(() => candidate.abort())
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'runtime publication and candidate cleanup failed',
            )
          }
        }
        throw error
      }
      if (stale) {
        await this.#mutation.mutate(() => candidate.abort())
        continue
      }
      if (!committed || !previous || !current) {
        throw new Error('E_RUNTIME_STATE_INVARIANT: publication completed without a state exchange')
      }
      this.#startRetirement(previous, current)
      return this.current()
    }
    throw new RuntimeStateStaleError(this.#maxRetries)
  }

  /** Wait for old-state retirement visible at call time. Publication success never depends on it. */
  async drainRetirements(): Promise<void> {
    const settled = await Promise.allSettled([...this.#retirements])
    const failures = [
      ...this.#retirementFailures.splice(0),
      ...settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
    ].filter((failure, index, all) => all.indexOf(failure) === index)
    if (failures.length > 0) throw new AggregateError(failures, 'runtime state retirement failed')
  }

  #startRetirement(previous: T, current: T): void {
    const retirement = this.#mutation.mutate(() => this.#retire(previous, current))
    this.#retirements.add(retirement)
    void retirement.then(
      () => this.#retirements.delete(retirement),
      (error) => {
        this.#retirements.delete(retirement)
        this.#retirementFailures.push(error)
      },
    )
  }
}
