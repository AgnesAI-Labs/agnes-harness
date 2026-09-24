export type PendingCoordinator<K> = Readonly<{
  run(key: K, operation: () => void | Promise<void>): Promise<void>
  has(key: K): boolean
}>

export function createPendingCoordinator<K>(): PendingCoordinator<K> {
  const pending = new Map<K, Promise<void>>()

  return {
    run(key, operation): Promise<void> {
      const existing = pending.get(key)
      if (existing) return existing

      let current!: Promise<void>
      current = Promise.resolve()
        .then(operation)
        .finally(() => {
          if (pending.get(key) === current) pending.delete(key)
        })
      pending.set(key, current)
      return current
    },
    has: (key) => pending.has(key),
  }
}
