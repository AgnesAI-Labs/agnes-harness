import { AsyncLocalStorage } from 'node:async_hooks'
import { CoreError } from '@agnes/core'

export type RuntimeReadLease = Readonly<{
  release(): void
  run<T>(callback: () => T): T
}>

/** Opaque capability passed to Host-owned callbacks which are allowed to re-enter a mutation. */
export type RuntimeMutationTicket = Readonly<{
  readonly __runtimeMutationTicket: unique symbol
}>

type ReadWaiter = Readonly<{
  active: { value: boolean }
  resolve(lease: RuntimeReadLease): void
  reject(error: unknown): void
  cleanup(): void
}>

function abortError(): Error {
  const error = new Error('runtime mutation gate operation aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

/**
 * Serializes Host-owned runtime mutations without putting plugin work inside PublicationGate.
 * Existing runtime calls acquire short leases; a mutation closes new admissions, drains those
 * leases, and executes outside the publication pointer's synchronous exchange.
 */
export class RuntimeMutationGate {
  readonly #context = new AsyncLocalStorage<RuntimeMutationTicket>()
  readonly #readContext = new AsyncLocalStorage<object>()
  readonly #readTickets = new WeakSet<object>()
  readonly #readMutationAncestors = new WeakMap<object, object>()
  readonly #tickets = new WeakSet<object>()
  #activeReaders = 0
  #admissionOpen = true
  #pendingMutations = 0
  #readWaiters: ReadWaiter[] = []
  #drainWaiters: Array<() => void> = []
  #writerTail: Promise<void> = Promise.resolve()

  /** Compound admission must not queue a second reader behind a writer blocked by its first. */
  tryEnterRead(): RuntimeReadLease | undefined {
    if (this.#liveMutationContext() || this.#liveReadContext()) return this.#noopLease()
    return this.#admissionOpen && this.#pendingMutations === 0 ? this.#issueLease() : undefined
  }

  /** Host-private ancestry for adding/removing scopes without changing the pinned generation. */
  retainedReadIdentity(): object | undefined {
    const ticket = this.#readContext.getStore()
    return ticket && this.#readTickets.has(ticket) ? ticket : undefined
  }

  withRetainedReadScope<T>(identity: object, callback: () => T): T {
    if (this.retainedReadIdentity() !== identity)
      throw new TypeError('runtime read ancestry is no longer live')
    const ticket = Object.freeze({}) as RuntimeMutationTicket
    this.#tickets.add(ticket)
    this.#readMutationAncestors.set(ticket, identity)
    return this.#context.run(ticket, callback)
  }

  enterRead(signal?: AbortSignal): Promise<RuntimeReadLease> {
    throwIfAborted(signal)
    if (this.#liveMutationContext() || this.#liveReadContext()) return Promise.resolve(this.#noopLease())
    if (this.#admissionOpen && this.#pendingMutations === 0) return Promise.resolve(this.#issueLease())

    return new Promise<RuntimeReadLease>((resolve, reject) => {
      const active = { value: true }
      let cleanup = (): void => undefined
      const waiter: ReadWaiter = {
        active,
        resolve,
        reject,
        cleanup: () => cleanup(),
      }
      const onAbort = (): void => {
        if (!active.value) return
        active.value = false
        cleanup()
        this.#removeReadWaiter(waiter)
        reject(abortError())
      }
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
        cleanup = () => signal.removeEventListener('abort', onAbort)
      }
      this.#readWaiters.push(waiter)
      if (signal?.aborted) onAbort()
    })
  }

  async withRead<T>(
    callback: (lease: RuntimeReadLease) => T | PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const lease = await this.enterRead(signal)
    try {
      return await callback(lease)
    } finally {
      lease.release()
    }
  }

  mutate<T>(
    callback: (ticket: RuntimeMutationTicket) => T | PromiseLike<T>,
    signal?: AbortSignal,
    noWait = false,
  ): Promise<T> {
    const current = this.#liveMutationContext()
    if (current) {
      try {
        throwIfAborted(signal)
        return Promise.resolve(this.#context.run(current, () => callback(current)))
      } catch (error) {
        return Promise.reject(error)
      }
    }
    try {
      throwIfAborted(signal)
    } catch (error) {
      return Promise.reject(error)
    }

    if (noWait && this.#activeReaders > 0)
      return Promise.reject(
        new CoreError('E_LANE_BUSY', 'Runtime publication is pinned by admitted work', {
          reason: 'runtime-publication-pending',
        }),
      )

    this.#pendingMutations += 1
    this.#admissionOpen = false
    const precedingWriter = this.#writerTail
    let releaseWriter!: () => void
    this.#writerTail = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })

    return this.#runMutation(precedingWriter, releaseWriter, callback, signal)
  }

  currentMutationTicket(): RuntimeMutationTicket | undefined {
    return this.#liveMutationContext()
  }

  withMutationTicket<T>(ticket: RuntimeMutationTicket, callback: () => T | PromiseLike<T>): Promise<T> {
    if (!this.#isTicket(ticket)) throw new TypeError('invalid runtime mutation ticket')
    return this.#context.run(ticket, () => Promise.resolve().then(callback))
  }

  /** Exposed for deterministic Host diagnostics and tests; not a publication state. */
  activeReadLeases(): number {
    return this.#activeReaders
  }

  #isTicket(ticket: RuntimeMutationTicket): boolean {
    const ancestor = this.#readMutationAncestors.get(ticket)
    return (
      typeof ticket === 'object' &&
      ticket !== null &&
      this.#tickets.has(ticket) &&
      (!ancestor || this.#readTickets.has(ancestor))
    )
  }

  #liveMutationContext(): RuntimeMutationTicket | undefined {
    const ticket = this.#context.getStore()
    return ticket && this.#isTicket(ticket) ? ticket : undefined
  }

  async #runMutation<T>(
    precedingWriter: Promise<void>,
    releaseWriter: () => void,
    callback: (ticket: RuntimeMutationTicket) => T | PromiseLike<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    let precedingFinished = false
    let releaseRequested = false
    const releaseAfterPreceding = (): void => {
      precedingFinished = true
      if (releaseRequested) releaseWriter()
    }
    void precedingWriter.then(releaseAfterPreceding, releaseAfterPreceding)
    try {
      await this.#waitFor(precedingWriter, signal)
      await this.#waitFor(this.#whenDrained(), signal)
      throwIfAborted(signal)
      const ticket = Object.freeze({}) as RuntimeMutationTicket
      this.#tickets.add(ticket)
      return await this.#context.run(ticket, () => Promise.resolve().then(() => callback(ticket)))
    } finally {
      this.#pendingMutations -= 1
      if (this.#pendingMutations === 0) {
        this.#admissionOpen = true
        this.#admitWaitingReaders()
      }
      releaseRequested = true
      if (precedingFinished) releaseWriter()
    }
  }

  #waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(abortError())
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const onAbort = (): void => {
        if (settled) return
        settled = true
        reject(abortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  #issueLease(): RuntimeReadLease {
    this.#activeReaders += 1
    let released = false
    const ticket = Object.freeze({})
    this.#readTickets.add(ticket)
    return Object.freeze({
      run: <T>(callback: () => T): T => {
        if (released) throw new TypeError('runtime read lease is released')
        return this.#readContext.run(ticket, callback)
      },
      release: () => {
        if (released) return
        released = true
        this.#readTickets.delete(ticket)
        this.#activeReaders -= 1
        if (this.#activeReaders !== 0) return
        const waiters = this.#drainWaiters.splice(0)
        for (const resolve of waiters) resolve()
      },
    })
  }

  #noopLease(): RuntimeReadLease {
    return Object.freeze({ release: () => undefined, run: <T>(callback: () => T): T => callback() })
  }
  #liveReadContext(): boolean {
    const ticket = this.#readContext.getStore()
    return ticket !== undefined && this.#readTickets.has(ticket)
  }

  #whenDrained(): Promise<void> {
    if (this.#activeReaders === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve)
    })
  }

  #removeReadWaiter(waiter: ReadWaiter): void {
    const index = this.#readWaiters.indexOf(waiter)
    if (index >= 0) this.#readWaiters.splice(index, 1)
  }

  #admitWaitingReaders(): void {
    if (!this.#admissionOpen || this.#pendingMutations !== 0) return
    const waiters = this.#readWaiters.splice(0)
    for (const waiter of waiters) {
      if (!waiter.active.value) continue
      waiter.active.value = false
      waiter.cleanup()
      waiter.resolve(this.#issueLease())
    }
  }
}
