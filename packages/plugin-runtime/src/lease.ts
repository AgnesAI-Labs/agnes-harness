import type { Fiber } from '@agnes/cordis'

export const SPINE_LEASES = 'spine:leases'

export class E_LEASE_DENIED extends Error {
  readonly code = 'E_LEASE_DENIED'

  constructor(readonly capability: PropertyKey) {
    super(`fiber does not hold capability lease: ${String(capability)}`)
    this.name = 'E_LEASE_DENIED'
  }
}

export class FiberLease<K extends PropertyKey = PropertyKey> {
  #active = true
  #dispose: (() => void | Promise<void>) | undefined

  constructor(
    readonly fiber: Fiber,
    readonly capability: K,
  ) {}

  get active(): boolean {
    return this.#active
  }

  _attach(dispose: () => void | Promise<void>): void {
    this.#dispose = dispose
  }

  _revoke(): void {
    this.#active = false
  }

  async release(): Promise<void> {
    if (!this.#active) return
    await this.#dispose?.()
  }
}

/** Capability leases indexed by the exact Cordis fiber that owns the invocation. */
export class FiberLeases<K extends PropertyKey = PropertyKey> {
  #bindings = new WeakMap<Fiber, Map<K, FiberLease<K>>>()

  bind(fiber: Fiber, capability: K): FiberLease<K> {
    fiber.assertActive()
    let bindings = this.#bindings.get(fiber)
    if (!bindings) {
      bindings = new Map()
      this.#bindings.set(fiber, bindings)
    }
    if (bindings.has(capability)) throw new Error(`fiber capability is already bound: ${String(capability)}`)

    const lease = new FiberLease(fiber, capability)
    bindings.set(capability, lease)
    const dispose = fiber.effect(
      () => () => {
        const current = this.#bindings.get(fiber)
        if (current?.get(capability) === lease) {
          current.delete(capability)
          if (!current.size) this.#bindings.delete(fiber)
        }
        lease._revoke()
      },
      `fiber-lease:${String(capability)}`,
    )
    lease._attach(dispose)
    return lease
  }

  require(fiber: Fiber, capability: K): FiberLease<K> {
    const lease = this.#bindings.get(fiber)?.get(capability)
    if (!lease?.active) throw new E_LEASE_DENIED(capability)
    return lease
  }
}
