import type { Context, Fiber } from '@agnes/cordis'
import type { RowOrigin, RowOriginRegistry } from './row-origin.js'

type WrapperClaim = Readonly<Record<string, unknown>>

/** Host-only gate state; no capability-bearing handle is exported to plugin authors. */
export class InternalMountGate {
  readonly #wrappers = new WeakMap<Fiber, WrapperClaim>()
  readonly #roots = new WeakMap<Context, { count: number; dispose: () => void }>()

  constructor(readonly origins: RowOriginRegistry) {}

  attach(root: Context): () => void {
    const current = this.#roots.get(root)
    if (current) {
      current.count += 1
      return this.#releaseRoot(root, current)
    }
    const gate = this
    const state = { count: 1, dispose: () => {} }
    const disposeProvide = root.on(
      'internal/provide',
      function (this: Context, name: string, value: unknown, next: () => void) {
        gate.assertProvide(this.fiber, name, value)
        return next()
      },
      { global: true, prepend: true },
    )
    const disposeDispatch = root.on(
      'internal/dispatch',
      function (this: Context, _mode, name, _args, _thisArg, system) {
        gate.assertDispatch(this.fiber, name, system)
      },
      { global: true, prepend: true },
    )
    const disposeListener = root.on(
      'internal/listener',
      function (this: Context, name: string | symbol) {
        if (typeof name !== 'string' || !name.startsWith('internal/')) return
        if (this.fiber.runtime === null) return
        const origin = gate.findOrigin(this.fiber)
        if (origin?.trustTier === 'builtin') return
        return () => false
      },
      { global: true, prepend: true },
    )
    state.dispose = () => {
      disposeListener()
      disposeDispatch()
      disposeProvide()
    }
    this.#roots.set(root, state)
    return this.#releaseRoot(root, state)
  }

  #releaseRoot(root: Context, state: { count: number; dispose: () => void }): () => void {
    let active = true
    return () => {
      if (!active) return
      active = false
      state.count -= 1
      if (state.count) return
      state.dispose()
      this.#roots.delete(root)
    }
  }

  bindWrapper(fiber: Fiber, values: WrapperClaim): () => void {
    if (this.#wrappers.has(fiber)) throw new Error('mount wrapper is already bound')
    this.#wrappers.set(fiber, values)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.#wrappers.delete(fiber)
    }
  }

  bindRow(fiber: Fiber, origin: Readonly<RowOrigin>): () => void {
    return this.origins.bind(fiber, origin)
  }

  private assertDispatch(source: Fiber, name: string, system: boolean): void {
    if (system || typeof name !== 'string' || !name.startsWith('internal/')) return
    const origin = this.findOrigin(source)
    if (origin?.trustTier === 'builtin') return
    const owner = origin?.rowId ?? 'unverified plugin'
    throw new Error(`E_INTERNAL_DISPATCH: ${owner} cannot dispatch ${name}`)
  }

  private findOrigin(source: Fiber): Readonly<RowOrigin> | undefined {
    let fiber = source
    while (true) {
      const origin = this.origins.lookup(fiber)
      if (origin) return origin
      if (fiber === fiber.parent.fiber || this.#wrappers.has(fiber)) return undefined
      fiber = fiber.parent.fiber
    }
  }

  private assertProvide(source: Fiber, name: string, value: unknown): void {
    const wrapper = this.#wrappers.get(source)
    if (wrapper) {
      if (!Object.hasOwn(wrapper, name) || !Object.is(wrapper[name], value)) {
        throw new Error(`E_EXACT_EXTRAS: wrapper cannot provide ${name}`)
      }
      return
    }

    let fiber: Fiber = source
    while (true) {
      const origin = this.origins.lookup(fiber)
      if (origin) {
        if (!origin.declaredProvides.includes(name)) {
          throw new Error(`E_PROVIDE_DENIED: ${origin.rowId} cannot provide ${name}`)
        }
        return
      }
      if (fiber === fiber.parent.fiber) {
        if (fiber === source) return
        throw new Error(`E_PROVIDE_DENIED: unverified plugin cannot provide ${name}`)
      }
      fiber = fiber.parent.fiber
      if (this.#wrappers.has(fiber)) {
        throw new Error(`E_PROVIDE_DENIED: unattested child cannot provide ${name}`)
      }
    }
  }
}
