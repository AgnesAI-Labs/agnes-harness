import type { Disposer } from '@agnes/extension-api'

type Release = () => void | Promise<void>

/** Successful releases are one-shot; failed releases remain visible and explicitly retryable. */
export class DisposerBag {
  private readonly entries = new Set<Release>()
  private closed = false
  private draining = false
  get size(): number {
    return this.entries.size
  }

  add(dispose: Disposer): Disposer {
    let running = false
    let pending: Promise<void> | undefined
    const release: Release = () => {
      if (!this.entries.has(release) || running) return
      if (pending) return pending
      running = true
      try {
        const result: unknown = dispose()
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          pending = Promise.resolve(result)
            .then(() => {
              this.entries.delete(release)
            })
            .finally(() => {
              pending = undefined
            })
          // A manually called Disposer has a void author signature; the bag still owns its rejection.
          void pending.catch(() => undefined)
          return pending
        }
        this.entries.delete(release)
      } finally {
        running = false
      }
    }
    this.entries.add(release)
    if (this.closed) release()
    return release
  }

  disposeAll(): { ran: number; failed: number } {
    if (this.draining) return { ran: 0, failed: this.entries.size }
    this.closed = true
    this.draining = true
    let ran = 0,
      failed = 0
    try {
      for (const release of [...this.entries].reverse()) {
        if (!this.entries.has(release)) continue
        try {
          if (release()) failed++
          else ran++
        } catch {
          failed++
        }
      }
    } finally {
      this.draining = false
    }
    return { ran, failed }
  }

  /** The host awaits extension cleanup; sync callers must not mistake pending work for completion. */
  async disposeAllAsync(): Promise<{ ran: number; failed: number }> {
    if (this.draining) return { ran: 0, failed: this.entries.size }
    this.closed = true
    this.draining = true
    let ran = 0,
      failed = 0
    try {
      for (const release of [...this.entries].reverse()) {
        if (!this.entries.has(release)) continue
        try {
          await release()
          ran++
        } catch {
          failed++
        }
      }
    } finally {
      this.draining = false
    }
    return { ran, failed }
  }
}

/** Notify a published generation when a live row adds or removes a registration. */
export class LateRegistrationBag extends DisposerBag {
  late = false
  #queued = false
  constructor(private readonly notify: () => void) {
    super()
  }
  override add(dispose: Disposer): Disposer {
    const release = super.add(dispose)
    this.#changed()
    return () => {
      const result: unknown = release()
      if (result instanceof Promise) return result.finally(() => this.#changed())
      this.#changed()
    }
  }
  #changed(): void {
    if (!this.late || this.#queued) return
    this.#queued = true
    queueMicrotask(() => {
      this.#queued = false
      this.notify()
    })
  }
}
