import { ProviderError } from '@agnes/extension-api'

/** One owner for admitted creates/calls and all instances they produce. */
export class ProviderLifetime {
  private readonly controller = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly resources = new Set<() => Promise<void>>()
  private disposal?: Promise<void>
  readonly signal = this.controller.signal
  constructor(
    private readonly kind: string,
    private readonly provider: string,
  ) {}
  assertActive(): void {
    if (this.signal.aborted)
      throw new ProviderError(
        'E_PROVIDER_UNAVAILABLE',
        `${this.kind} provider was unloaded: ${this.provider}`,
        {
          kind: this.kind,
          provider: this.provider,
          operation: 'invoke',
        },
      )
  }
  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    )
    return operation
  }
  run<T>(operation: (signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    this.assertActive()
    const joined = signal ? AbortSignal.any([signal, this.signal]) : this.signal
    joined.throwIfAborted()
    return this.track(
      Promise.resolve()
        .then(() => {
          joined.throwIfAborted()
          return operation(joined)
        })
        .then((value) => {
          joined.throwIfAborted()
          return value
        }),
    )
  }
  /** Attach before checking cancellation: late factory results still belong to this owner. */
  own(dispose: () => void | Promise<void>): () => Promise<void> {
    let disposal: Promise<void> | undefined
    const release = () => {
      disposal ??= Promise.resolve()
        .then(dispose)
        .then(() => {
          this.resources.delete(release)
        })
      return disposal
    }
    this.resources.add(release)
    return release
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
  close(cleanup?: () => void | Promise<void>, cancel?: () => void | Promise<void>): Promise<void> {
    if (!this.disposal) {
      this.controller.abort()
      this.disposal = Promise.resolve().then(async () => {
        // Creating operations attach their late instances before settling.
        const cancellations = await Promise.allSettled([Promise.resolve().then(() => cancel?.())])
        await this.drain()
        const results = await Promise.allSettled([...this.resources].map((dispose) => dispose()))
        results.push(...cancellations)
        results.push(...(await Promise.allSettled([Promise.resolve().then(() => cleanup?.())])))
        this.resources.clear()
        const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
        if (errors.length) throw new AggregateError(errors, `${this.kind} provider cleanup failed`)
      })
    }
    return this.disposal
  }
}
