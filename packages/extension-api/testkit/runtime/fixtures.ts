/**
 * In-memory inbox fixture. Nothing is persisted.
 * Each instance mints delivery ids in its own namespace. Repeating a delivery
 * key returns that id and does not wake waiters again. read accepts only an id
 * this instance issued; an id from another instance is rejected.
 * Acceptance is `{ deliveryId }` only. The public surface has no type that
 * pairs a delivery id with a runtime reference, and this fixture does not
 * stand in for the state store.
 */
export const RUNTIME_INBOX_FIXTURE = 'runtime-inbox' as const

export interface RuntimeInboxAcceptance {
  readonly deliveryId: string
}

export interface RuntimeInboxNotice extends RuntimeInboxAcceptance {
  readonly woken: number
}

export interface RuntimeInboxFixture {
  readonly kind: 'fixture'
  readonly persistent: false
  registerWaiter(deliveryKey: string, wake: (acceptance: RuntimeInboxAcceptance) => void): void
  notify(deliveryKey: string): RuntimeInboxNotice
  read<T>(deliveryId: string, terminal: T): T
}

export function createRuntimeInboxFixture(): RuntimeInboxFixture {
  const namespace = `fixture-inbox-${crypto.randomUUID()}`
  const waiters = new Map<string, ((acceptance: RuntimeInboxAcceptance) => void)[]>()
  const fired = new Map<string, string>()
  return {
    kind: 'fixture',
    persistent: false,
    registerWaiter(deliveryKey, wake) {
      const existing = waiters.get(deliveryKey)
      if (existing === undefined) waiters.set(deliveryKey, [wake])
      else existing.push(wake)
    },
    notify(deliveryKey) {
      if (fired.has(deliveryKey)) return { deliveryId: fired.get(deliveryKey) as string, woken: 0 }
      const deliveryId = `${namespace}-delivery-${fired.size + 1}`
      fired.set(deliveryKey, deliveryId)
      const acceptance = { deliveryId }
      const queued = [...(waiters.get(deliveryKey) ?? [])]
      for (const wake of queued) wake(acceptance)
      return { deliveryId, woken: queued.length }
    },
    read(deliveryId, terminal) {
      if (![...fired.values()].includes(deliveryId)) throw new Error('unknown delivery')
      return terminal
    },
  }
}
