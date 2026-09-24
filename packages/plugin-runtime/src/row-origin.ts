import type { Fiber } from '@agnes/cordis'

export interface RowOrigin {
  readonly trustTier: 'third-party' | 'builtin'
  readonly packageId: string
  readonly snapshotId: string
  readonly rowId: string
  readonly exportName: string
  readonly declaredProvides: readonly string[]
}

export interface RowOriginLookup {
  lookup(fiber: Fiber): Readonly<RowOrigin> | undefined
}

/** Private ownership index. Entries are installed before a prepared fiber is published. */
export class RowOriginRegistry implements RowOriginLookup {
  readonly #origins = new WeakMap<Fiber, Readonly<RowOrigin>>()

  lookup(fiber: Fiber): Readonly<RowOrigin> | undefined {
    return this.#origins.get(fiber)
  }

  bind(fiber: Fiber, origin: Readonly<RowOrigin>): () => void {
    if (this.#origins.has(fiber)) throw new Error('row origin is already bound')
    this.#origins.set(fiber, origin)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.#origins.delete(fiber)
    }
  }
}
