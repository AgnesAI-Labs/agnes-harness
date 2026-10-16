/** Backoff belongs to an active operation and is forgotten when that operation settles. */
export class OperationBackoff {
  readonly #attempts = new Map<string, number>()
  constructor(private readonly timers: Map<string, number>) {}
  get active(): boolean {
    return this.timers.size > 0 || this.#attempts.size > 0
  }
  next(id: string, base: number): number {
    const attempt = this.#attempts.get(id) ?? 0
    this.#attempts.set(id, Math.min(5, attempt + 1))
    return Math.min(30_000, base * 2 ** attempt)
  }
  schedule(id: string, base: number, read: () => void): void {
    const timers = this.timers
    timers.set(
      id,
      window.setTimeout(
        () => {
          timers.delete(id)
          read()
        },
        this.next(id, base),
      ),
    )
  }
  forget(id: string): void {
    this.#attempts.delete(id)
  }
}

/** Keep operation receipts, but stop their scheduled network reads while hidden. */
export function bindOperationVisibility(
  timers: Map<string, number>,
  resume: () => void,
  signal: AbortSignal,
): void {
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState !== 'hidden') return resume()
      for (const [id, timer] of timers) {
        if (timer >= 0) {
          clearTimeout(timer)
          timers.delete(id)
        }
      }
    },
    { signal },
  )
}
