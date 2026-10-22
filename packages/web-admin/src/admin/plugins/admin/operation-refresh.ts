import type { PackageInstalledDescriptor, PackageOperation } from '@agnes/protocol'

/** Backoff belongs to an active operation and is forgotten when that operation settles. */
export class OperationBackoff {
  readonly #attempts = new Map<string, number>()
  constructor(private readonly timers: Map<string, number>) {}
  get active(): boolean {
    return this.timers.size > 0 || this.#attempts.size > 0
  }
  /** `max` bounds the wait: a finished operation is noticed at the next read, never later than this. */
  next(id: string, base: number, max = 30_000): number {
    const attempt = this.#attempts.get(id) ?? 0
    this.#attempts.set(id, Math.min(5, attempt + 1))
    return Math.min(max, base * 2 ** attempt)
  }
  schedule(id: string, base: number, read: () => void, max?: number): void {
    const timers = this.timers
    timers.set(
      id,
      window.setTimeout(
        () => {
          timers.delete(id)
          read()
        },
        this.next(id, base, max),
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

/**
 * A completed enable or disable already says what the plugin now wants. Showing that at once keeps the
 * switch in step with the notice, instead of waiting for the next full inventory read to land.
 */
export function withOperationDesired(
  installed: readonly PackageInstalledDescriptor[],
  operation: PackageOperation,
): readonly PackageInstalledDescriptor[] {
  const result = operation.installed
  if (operation.state !== 'completed' || !result) return installed
  if (operation.operation !== 'enable' && operation.operation !== 'disable') return installed
  if (!installed.some((row) => row.id === result.id && row.desired !== result.desired)) return installed
  return installed.map((row) => (row.id === result.id ? { ...row, desired: result.desired } : row))
}
