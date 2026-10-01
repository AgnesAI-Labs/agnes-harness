/**
 * Non-persistent inbox fixture for tests.
 * The generated public surface has no acceptance result carrying a delivery id
 * and a runtime reference. CommandHandle.result is a data reference. The state
 * intake receipt belongs to the state store, which this fixture does not replace.
 * The returned delivery id is valid only on this instance.
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
