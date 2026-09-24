export const E_CANDIDATE_REVOKED = 'E_CANDIDATE_REVOKED'

export type CandidateRuntimeErrorCode =
  | typeof E_CANDIDATE_REVOKED
  | 'E_CANDIDATE_FINALIZED'
  | 'E_CANDIDATE_VALIDATION_PENDING'
  | 'E_CANDIDATE_PROVIDER_DUPLICATE'
  | 'E_CANDIDATE_PROVIDER_MISSING'

export class CandidateRuntimeError extends Error {
  constructor(
    readonly code: CandidateRuntimeErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'CandidateRuntimeError'
  }
}

export type CandidateCleanup = () => void | Promise<void>

/**
 * The only surface handed from Host's candidate owner into candidate assembly. It deliberately has
 * no terminal operation or authority token: plugins can resolve transaction-local capabilities,
 * but only the owning CandidateRuntime can commit or abort the transaction.
 */
export type CandidateRuntimeBuilder = Readonly<{
  provide<T>(key: string, value: T): void
  resolve<T>(key: string): T
  createFacade<T>(value: T): T
  createSideEffectPort<T>(value: T): T
  onAbort(label: string, cleanup: CandidateCleanup): void
}>

type CleanupEntry = Readonly<{ label: string; cleanup: CandidateCleanup }>

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isObject(value) && typeof (value as { then?: unknown }).then === 'function'
}

class RuntimePublicationTransaction {
  #active = true
  #providers = new Map<string, unknown>()
  #cleanups: CleanupEntry[] = []
  readonly #facades = new WeakMap<object, object>()
  readonly builder: CandidateRuntimeBuilder

  constructor() {
    this.builder = Object.freeze({
      provide: <T>(key: string, value: T) => this.#provide(key, value),
      resolve: <T>(key: string) => this.#resolve<T>(key),
      createFacade: <T>(value: T) => this.#wrap(value),
      createSideEffectPort: <T>(value: T) => this.#wrap(value),
      onAbort: (label: string, cleanup: CandidateCleanup) => this.#onAbort(label, cleanup),
    })
  }

  revoke(): void {
    if (!this.#active) return
    this.#active = false
    this.#providers.clear()
  }

  /** Successful publication never runs abort-only cleanup, so release its captured resources. */
  discardAbortCleanups(): void {
    this.#cleanups = []
  }

  async drainAbortCleanups(): Promise<unknown[]> {
    const failures: unknown[] = []
    for (let index = this.#cleanups.length - 1; index >= 0; index -= 1) {
      const entry = this.#cleanups[index]
      if (!entry) continue
      try {
        await entry.cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    this.#cleanups = []
    return failures
  }

  #assertActive(): void {
    if (!this.#active)
      throw new CandidateRuntimeError(
        E_CANDIDATE_REVOKED,
        'candidate transaction capability is no longer active',
      )
  }

  #provide<T>(key: string, value: T): void {
    this.#assertActive()
    if (!key) throw new TypeError('candidate provider key is required')
    if (this.#providers.has(key))
      throw new CandidateRuntimeError(
        'E_CANDIDATE_PROVIDER_DUPLICATE',
        `candidate provider already exists: ${key}`,
      )
    this.#providers.set(key, value)
  }

  #resolve<T>(key: string): T {
    this.#assertActive()
    if (!this.#providers.has(key))
      throw new CandidateRuntimeError(
        'E_CANDIDATE_PROVIDER_MISSING',
        `candidate provider is unavailable: ${key}`,
      )
    return this.#wrap(this.#providers.get(key) as T)
  }

  #onAbort(label: string, cleanup: CandidateCleanup): void {
    this.#assertActive()
    if (!label) throw new TypeError('candidate cleanup label is required')
    if (typeof cleanup !== 'function') throw new TypeError('candidate cleanup must be a function')
    this.#cleanups.push(Object.freeze({ label, cleanup }))
  }

  #wrapResult<T>(value: T): T {
    let promiseLike: boolean
    try {
      promiseLike = isPromiseLike(value)
    } catch (error) {
      throw this.#wrapThrown(error)
    }
    if (!promiseLike) return this.#wrap(value)
    return Promise.resolve(value).then(
      (result) => {
        this.#assertActive()
        return this.#wrap(result)
      },
      (error) => {
        this.#assertActive()
        throw this.#wrapThrown(error)
      },
    ) as T
  }

  #wrapFunction<T extends (...args: never[]) => unknown>(fn: T, receiver?: object): T {
    const transaction = this
    return function candidateCapability(this: unknown, ...args: never[]): unknown {
      transaction.#assertActive()
      try {
        return transaction.#wrapResult(Reflect.apply(fn, receiver ?? this, args))
      } catch (error) {
        transaction.#assertActive()
        throw transaction.#wrapThrown(error)
      }
    } as T
  }

  #wrap<T>(value: T): T {
    this.#assertActive()
    if (!isObject(value)) return value
    let promiseLike: boolean
    try {
      promiseLike = isPromiseLike(value)
    } catch (error) {
      throw this.#wrapThrown(error)
    }
    if (promiseLike) return this.#wrapResult(value)
    if (typeof value === 'function') return this.#wrapFunction(value as (...args: never[]) => unknown) as T
    return this.#wrapObject(value) as T
  }

  /** Exception values are capabilities too; wrap them without probing a potentially hostile `then`. */
  #wrapThrown<T>(value: T): T {
    this.#assertActive()
    if (!isObject(value)) return value
    if (typeof value === 'function') return this.#wrapFunction(value as (...args: never[]) => unknown) as T
    return this.#wrapObject(value) as T
  }

  #attempt<T>(operation: () => T): T {
    try {
      return operation()
    } catch (error) {
      this.#assertActive()
      throw this.#wrapThrown(error)
    }
  }

  #wrapObject(value: object): object {
    const cached = this.#facades.get(value)
    if (cached) return cached
    const transaction = this
    const facade = new Proxy(Object.create(null) as object, {
      get(_target, property) {
        transaction.#assertActive()
        const member = transaction.#attempt(() => Reflect.get(value, property, value))
        return typeof member === 'function'
          ? transaction.#wrapFunction(member as (...args: never[]) => unknown, value)
          : transaction.#wrap(member)
      },
      set(_target, property, next) {
        transaction.#assertActive()
        return transaction.#attempt(() => Reflect.set(value, property, next, value))
      },
      has(_target, property) {
        transaction.#assertActive()
        return transaction.#attempt(() => Reflect.has(value, property))
      },
      ownKeys() {
        transaction.#assertActive()
        return transaction.#attempt(() => Reflect.ownKeys(value))
      },
      getOwnPropertyDescriptor(_target, property) {
        transaction.#assertActive()
        const descriptor = transaction.#attempt(() => Reflect.getOwnPropertyDescriptor(value, property))
        if (!descriptor) return undefined
        return {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          writable: true,
          value: transaction.#wrap(transaction.#attempt(() => Reflect.get(value, property, value))),
        }
      },
      defineProperty(_target, property, descriptor) {
        transaction.#assertActive()
        return transaction.#attempt(() => Reflect.defineProperty(value, property, descriptor))
      },
      deleteProperty(_target, property) {
        transaction.#assertActive()
        return transaction.#attempt(() => Reflect.deleteProperty(value, property))
      },
    })
    this.#facades.set(value, facade)
    return facade
  }
}

type CandidateStatus = 'staged' | 'committed' | 'aborting' | 'aborted'

/** Host-owned staged runtime. It is never handed to plugins or placed behind a public dispatch API. */
export interface CandidateRuntime<T> {
  /** Run every throwable/CAS validation before the publication gate's pointer exchange. */
  precommit(validate: (value: T) => void | Promise<void>): Promise<void>
  /** Synchronous, callback-free and cleanup-free terminal transition. */
  commit(): T
  /** Revoke first, then clean candidate-owned resources in reverse registration order. */
  abort(): Promise<void>
}

class CandidateRuntimeImpl<T> implements CandidateRuntime<T> {
  #status: CandidateStatus = 'staged'
  #validations = 0

  constructor(
    private readonly value: T,
    private transaction: RuntimePublicationTransaction | undefined,
  ) {}

  /** Run every throwable/CAS validation before the publication gate's pointer exchange. */
  async precommit(validate: (value: T) => void | Promise<void>): Promise<void> {
    this.#assertStaged()
    this.#validations += 1
    try {
      await validate(this.value)
    } finally {
      this.#validations -= 1
    }
  }

  /** Synchronous, callback-free and cleanup-free terminal transition. */
  commit(): T {
    this.#assertStaged()
    if (this.#validations !== 0)
      throw new CandidateRuntimeError(
        'E_CANDIDATE_VALIDATION_PENDING',
        'candidate validation has not settled',
      )
    this.#status = 'committed'
    this.transaction?.revoke()
    this.transaction?.discardAbortCleanups()
    this.transaction = undefined
    return this.value
  }

  /** Revoke first, then clean candidate-owned resources in reverse registration order. */
  async abort(): Promise<void> {
    this.#assertStaged()
    if (this.#validations !== 0)
      throw new CandidateRuntimeError(
        'E_CANDIDATE_VALIDATION_PENDING',
        'candidate validation has not settled',
      )
    this.#status = 'aborting'
    const transaction = this.transaction
    transaction?.revoke()
    const failures = (await transaction?.drainAbortCleanups()) ?? []
    this.transaction = undefined
    this.#status = 'aborted'
    if (failures.length > 0) throw new AggregateError(failures, 'candidate runtime abort cleanup failed')
  }

  #assertStaged(): void {
    if (this.#status !== 'staged')
      throw new CandidateRuntimeError('E_CANDIDATE_FINALIZED', `candidate runtime is already ${this.#status}`)
  }
}

/** Build and initially validate a completely invisible candidate, cleaning it on any failure. */
export async function stageCandidateRuntime<T>(options: {
  build(builder: CandidateRuntimeBuilder): T | Promise<T>
  validate?(value: T): void | Promise<void>
}): Promise<CandidateRuntime<T>> {
  const transaction = new RuntimePublicationTransaction()
  try {
    const value = await options.build(transaction.builder)
    await options.validate?.(value)
    return new CandidateRuntimeImpl(value, transaction)
  } catch (primary) {
    transaction.revoke()
    const failures = await transaction.drainAbortCleanups()
    if (failures.length > 0)
      throw new AggregateError([primary, ...failures], 'candidate runtime staging and cleanup failed')
    throw primary
  }
}
