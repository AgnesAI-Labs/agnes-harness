import type { ExtensionStatus } from './managed-host.js'

/** One counter shared by every extension store, so a merged listing keeps first-seen order. */
export type ExtensionOrder = Readonly<{ next(): number }>

export function createExtensionOrder(): ExtensionOrder {
  let counter = 0
  return Object.freeze({ next: () => counter++ })
}

export type OrderedExtensionStatus = Readonly<{ order: number; status: ExtensionStatus }>

/**
 * Status of extensions the managed host does not own. An id keeps the position it was first seen
 * at, so remounting a row never reshuffles `Host.extensions()`.
 */
export class ExtensionStatusBook {
  readonly #entries = new Map<string, { order: number; status: ExtensionStatus }>()

  constructor(private readonly order: ExtensionOrder) {}

  set(status: ExtensionStatus): void {
    const previous = this.#entries.get(status.id)
    this.#entries.set(status.id, { order: previous?.order ?? this.order.next(), status })
  }

  entries(): OrderedExtensionStatus[] {
    return [...this.#entries.values()]
  }
}

/** Both stores in first-seen order; a builtin that a plugin row has replaced names its replacement. */
export function mergeExtensionStatus(
  stores: readonly (readonly OrderedExtensionStatus[])[],
  replacedBy: (id: string) => string | undefined,
): ExtensionStatus[] {
  return stores
    .flat()
    .sort((a, b) => a.order - b.order)
    .map(({ status }) => {
      const by = status.loaded ? undefined : replacedBy(status.id)
      return by === undefined ? status : { ...status, replacedBy: by }
    })
}
