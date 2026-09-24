export interface PublicationReadTicket {
  /** Releases this admission exactly once. Repeated calls are harmless. */
  release(): void
}

export type PublicationCloseOptions = Readonly<{
  /** Fatal publication failures keep future dispatches queued until the process is replaced. */
  onError?: 'reopen' | 'keep-closed' | ((error: unknown) => 'reopen' | 'keep-closed')
}>

type ReadWaiter = (ticket: PublicationReadTicket) => void

/**
 * Coordinates the short synchronous boundary where dispatch reads the published runtime and hands
 * the selected target to its concrete lifecycle owner. A read ticket must not span the invoked
 * operation: the caller releases it immediately after that synchronous handoff.
 *
 * This is deliberately not a re-entrant reader/writer lock. Calling `withClosed()` while retaining
 * a read ticket waits for that same ticket, so dispatch code cannot accidentally upgrade a read and
 * carry publication ownership into user work.
 */
export class PublicationGate {
  #activeReaders = 0
  #admissionOpen = true
  #fatalClosed = false
  #fatalError: unknown
  #pendingWriters = 0
  #readWaiters: ReadWaiter[] = []
  #drainWaiters: Array<() => void> = []
  #writerTail: Promise<void> = Promise.resolve()

  /** Enters the current publication for a short read-and-handoff boundary. */
  enterDispatch(): Promise<PublicationReadTicket> {
    if (this.#admissionOpen && !this.#fatalClosed && this.#pendingWriters === 0)
      return Promise.resolve(this.#issueTicket())
    return new Promise<PublicationReadTicket>((resolve) => {
      this.#readWaiters.push(resolve)
    })
  }

  /**
   * Runs one publication writer after all previously admitted reads release. The close takes effect
   * synchronously when this method is called: later `enterDispatch()` calls queue even before this writer's
   * callback begins. Writers are serialized and readers cannot slip between queued writers.
   */
  withClosed<T>(callback: () => T | Promise<T>, options: PublicationCloseOptions = {}): Promise<T> {
    this.#pendingWriters += 1
    this.#admissionOpen = false

    const precedingWriter = this.#writerTail
    let releaseWriter!: () => void
    this.#writerTail = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })

    return this.#runWriter(precedingWriter, releaseWriter, callback, options)
  }

  async #runWriter<T>(
    precedingWriter: Promise<void>,
    releaseWriter: () => void,
    callback: () => T | Promise<T>,
    options: PublicationCloseOptions,
  ): Promise<T> {
    await precedingWriter
    await this.#whenDrained()
    try {
      if (this.#fatalClosed) throw this.#fatalError
      return await callback()
    } catch (error) {
      const disposition =
        typeof options.onError === 'function' ? options.onError(error) : (options.onError ?? 'reopen')
      if (disposition === 'keep-closed' && !this.#fatalClosed) {
        this.#fatalClosed = true
        this.#fatalError = error
      }
      throw error
    } finally {
      this.#pendingWriters -= 1
      if (this.#pendingWriters === 0 && !this.#fatalClosed) {
        this.#admissionOpen = true
        this.#admitWaitingReaders()
      }
      releaseWriter()
    }
  }

  #issueTicket(): PublicationReadTicket {
    this.#activeReaders += 1
    let released = false
    return Object.freeze({
      release: () => {
        if (released) return
        released = true
        this.#activeReaders -= 1
        if (this.#activeReaders !== 0) return
        const waiters = this.#drainWaiters.splice(0)
        for (const resolve of waiters) resolve()
      },
    })
  }

  #whenDrained(): Promise<void> {
    if (this.#activeReaders === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve)
    })
  }

  #admitWaitingReaders(): void {
    if (!this.#admissionOpen || this.#fatalClosed || this.#pendingWriters !== 0) return
    const waiters = this.#readWaiters.splice(0)
    for (const resolve of waiters) resolve(this.#issueTicket())
  }
}
