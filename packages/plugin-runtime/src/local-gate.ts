export const E_LOCAL_GATE_FATAL = 'E_LOCAL_GATE_FATAL'

export type LocalGateReadRelease = () => void

export type LocalGateClosedOptions = Readonly<{
  /** Keep the gate closed only when the transaction rejects. */
  fatal?: boolean
}>

interface ReadWaiter {
  resolve(release: LocalGateReadRelease): void
  reject(error: Error): void
}

/**
 * A process-local read/drain gate for worker command admission.
 *
 * Entering a closed transaction blocks new readers, waits for accepted readers to drain, and never
 * upgrades an existing reader. Callers must release their read before a closed transaction can run.
 */
export class LocalGate {
  #open = true
  #fatal = false
  #fatalCause: unknown
  #activeReads = 0
  #pendingWriters = 0
  #readWaiters: ReadWaiter[] = []
  #drainWaiter: { promise: Promise<void>; resolve(): void } | undefined
  #writerTail: Promise<void> = Promise.resolve()

  get isOpen(): boolean {
    return this.#open && !this.#fatal
  }

  enterRead(): Promise<LocalGateReadRelease> {
    if (this.#fatal) return Promise.reject(this.#fatalError())
    if (this.#open && this.#pendingWriters === 0) {
      this.#activeReads += 1
      return Promise.resolve(this.#releaseRead())
    }
    return new Promise((resolve, reject) => this.#readWaiters.push({ resolve, reject }))
  }

  async withClosed<T>(transaction: () => T | Promise<T>, options: LocalGateClosedOptions = {}): Promise<T> {
    if (this.#fatal) throw this.#fatalError()

    this.#pendingWriters += 1
    this.#open = false
    const predecessor = this.#writerTail
    let finishTurn = () => {}
    this.#writerTail = new Promise<void>((resolve) => {
      finishTurn = resolve
    })

    await predecessor
    try {
      if (this.#fatal) throw this.#fatalError()
      await this.#whenDrained()
      return await transaction()
    } catch (error) {
      if (options.fatal && !this.#fatal) {
        this.#fatal = true
        this.#fatalCause = error
        this.#rejectReaders()
      }
      throw error
    } finally {
      this.#pendingWriters -= 1
      finishTurn()
      if (!this.#fatal && this.#pendingWriters === 0) this.#reopen()
    }
  }

  #releaseRead(): LocalGateReadRelease {
    let active = true
    return () => {
      if (!active) return
      active = false
      this.#activeReads -= 1
      if (this.#activeReads !== 0) return
      const waiter = this.#drainWaiter
      this.#drainWaiter = undefined
      waiter?.resolve()
    }
  }

  #whenDrained(): Promise<void> {
    if (this.#activeReads === 0) return Promise.resolve()
    if (!this.#drainWaiter) {
      let resolve = () => {}
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      this.#drainWaiter = { promise, resolve }
    }
    return this.#drainWaiter.promise
  }

  #reopen(): void {
    this.#open = true
    const waiters = this.#readWaiters
    this.#readWaiters = []
    this.#activeReads += waiters.length
    for (const waiter of waiters) waiter.resolve(this.#releaseRead())
  }

  #rejectReaders(): void {
    const waiters = this.#readWaiters
    this.#readWaiters = []
    for (const waiter of waiters) waiter.reject(this.#fatalError())
  }

  #fatalError(): Error {
    return new Error(`${E_LOCAL_GATE_FATAL}: gate is permanently closed`, { cause: this.#fatalCause })
  }
}
