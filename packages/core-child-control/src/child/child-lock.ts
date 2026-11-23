import type { SessionKey } from '@agnes/core-common/types'

/**
 * Per-child async critical-section serializer (DSH-inspired).
 * Linearizes control actions, state transitions, delivery and disposal for a single childKey
 * while absorbing prior rejections on the chaining tail so one failed control call never
 * poisons subsequent operations on the same child.
 */
export class ChildLock {
  private readonly tails = new Map<SessionKey, Promise<void>>()

  run<T>(childKey: SessionKey, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(childKey) ?? Promise.resolve()
    let tail!: Promise<void>
    const result = previous.then(operation, operation).finally(() => {
      if (this.tails.get(childKey) === tail) this.tails.delete(childKey)
    })
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(childKey, tail)
    return result
  }

  hasPending(childKey: SessionKey): boolean {
    return this.tails.has(childKey)
  }
}
