import type { Timing } from '@agnes/protocol'

/** One clock domain, scoped to the provider invocation, never the enclosing turn. */
export class InferenceTiming {
  private readonly started: number
  private preparedAt?: number
  private dispatchedAt?: number
  private firstAt?: number
  private endedAt?: number
  private captureDepth = 0
  private captureStart = 0
  private captureTotal = 0
  private captured = false
  constructor(private readonly clock: () => number) {
    this.started = clock()
  }
  prepared(): void {
    this.preparedAt = this.clock()
  }
  dispatched(): void {
    this.dispatchedAt ??= this.clock()
  }
  output(): void {
    this.firstAt ??= this.clock()
  }
  ended(): void {
    this.endedAt ??= this.clock()
  }
  async capture<T>(action: () => Promise<T>): Promise<T> {
    this.captured = true
    if (this.captureDepth++ === 0) this.captureStart = this.clock()
    try {
      return await action()
    } finally {
      if (--this.captureDepth === 0) this.captureTotal += Math.max(0, this.clock() - this.captureStart)
    }
  }
  snapshot(final: boolean): Timing {
    const now = this.clock()
    const elapsed = (end: number, start = this.started) => Math.max(0, Math.round(end - start))
    return {
      ...(final ? { providerCallMs: elapsed(now) } : {}),
      ...(this.preparedAt === undefined ? {} : { prepareMs: elapsed(this.preparedAt) }),
      ...(final && this.captured ? { captureMs: Math.round(this.captureTotal) } : {}),
      ...(this.dispatchedAt === undefined ? {} : { dispatchMs: elapsed(this.dispatchedAt) }),
      ...(this.firstAt === undefined ? {} : { firstOutputMs: elapsed(this.firstAt) }),
      ...(this.firstAt === undefined || this.endedAt === undefined
        ? {}
        : { outputMs: elapsed(this.endedAt, this.firstAt) }),
      ...(!final || this.endedAt === undefined ? {} : { finalizeMs: elapsed(now, this.endedAt) }),
    }
  }
}
