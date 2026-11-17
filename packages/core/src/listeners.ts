/**
 * A set of change listeners. A listener must not disturb the code that notifies it, so one that throws
 * is skipped, and `emit` calls a snapshot, so a listener added or removed meanwhile changes only later calls.
 */
export class Listeners<A extends unknown[] = []> {
  private readonly set = new Set<(...args: A) => void>()

  /** Adds a listener; the returned function removes it. */
  readonly on = (fn: (...args: A) => void): (() => void) => {
    this.set.add(fn)
    return () => void this.set.delete(fn)
  }

  emit(...args: A): void {
    for (const fn of [...this.set]) {
      try {
        fn(...args)
      } catch {
        // A listener must not disturb its notifier.
      }
    }
  }

  /** Emits once `change` resolves and returns its result; a rejection passes through without emitting. */
  async after<T>(change: Promise<T>, ...args: A): Promise<T> {
    const result = await change
    this.emit(...args)
    return result
  }
}
