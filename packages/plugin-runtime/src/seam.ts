export class E_SEAM_UNAVAILABLE extends Error {
  readonly code = 'E_SEAM_UNAVAILABLE'

  constructor(readonly seam: string) {
    super(`seam is unavailable: ${seam}`)
    this.name = 'E_SEAM_UNAVAILABLE'
  }
}

export type OrdinaryDispatch = Readonly<{
  ordinary<T>(resolve: () => () => T | Promise<T>): Promise<Awaited<T>>
}>

/** A single-provider seam with a stable, frozen forwarding facade. */
export class SeamRuntime<T extends object> {
  readonly facade: T
  #current: T | undefined
  #forwarders = new Map<PropertyKey, (...args: unknown[]) => unknown>()
  #callable = new Set<PropertyKey>()

  constructor(
    readonly name: string,
    private readonly dispatch?: OrdinaryDispatch,
  ) {
    const target = Object.create(null) as T
    this.facade = Object.freeze(
      new Proxy(target, {
        get: (_target, key) => {
          if (this.dispatch && key !== 'onGrantRevoked' && this.#callable.has(key)) {
            return this.#forwarder(key)
          }
          const current = this.#current
          if (!current) throw new E_SEAM_UNAVAILABLE(this.name)
          const value = Reflect.get(current, key, current) as unknown
          if (typeof value !== 'function') return value
          this.#callable.add(key)
          return this.#forwarder(key)
        },
        set: () => false,
      }),
    )
  }

  provide(value: T): () => void {
    if (this.#current) throw new Error(`seam already has a provider: ${this.name}`)
    // Learn the fixed seam method surface while a generation is fully published. A later getter in
    // the unmount/mount window can then return a stable forwarder without touching `#current`; the
    // forwarder's dispatch ticket resolves the replacement generation.
    for (
      let cursor: object | null = value;
      cursor && cursor !== Object.prototype;
      cursor = Reflect.getPrototypeOf(cursor)
    ) {
      for (const key of Reflect.ownKeys(cursor)) {
        if (key === 'constructor') continue
        const descriptor = Reflect.getOwnPropertyDescriptor(cursor, key)
        if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') {
          this.#callable.add(key)
        }
      }
    }
    this.#current = value
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.#current === value) this.invalidate()
    }
  }

  invalidate(): void {
    this.#current = undefined
  }

  #forwarder(key: PropertyKey): (...args: unknown[]) => unknown {
    let forward = this.#forwarders.get(key)
    if (forward) return forward
    forward = (...args: unknown[]) => {
      const resolve = () => {
        const live = this.#current
        if (!live) throw new E_SEAM_UNAVAILABLE(this.name)
        const method = Reflect.get(live, key, live) as unknown
        if (typeof method !== 'function') throw new TypeError(`seam member is not callable: ${String(key)}`)
        return () => Reflect.apply(method, live, args)
      }
      // Listener registration returns a synchronous disposer and does not dispatch business work.
      // Every operational seam member is asynchronous and goes through publication.
      return this.dispatch && key !== 'onGrantRevoked' ? this.dispatch.ordinary(resolve) : resolve()()
    }
    this.#forwarders.set(key, forward)
    return forward
  }
}

export function freezeSpineFacade<T extends object>(runtime: SeamRuntime<T>): T {
  return runtime.facade
}
