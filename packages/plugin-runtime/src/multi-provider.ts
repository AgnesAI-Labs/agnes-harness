/** Deterministic contributions grouped by their live owner. */
export class MultiProviderRegistry<T> {
  #owners = new Map<object, readonly T[]>()

  registerFrom(owner: object, values: readonly T[]): () => void {
    if (this.#owners.has(owner)) throw new Error('provider owner is already registered')
    this.#owners.set(owner, Object.freeze([...values]))
    let active = true
    return () => {
      if (!active) return
      active = false
      this.#owners.delete(owner)
    }
  }

  snapshot(): readonly T[] {
    return Object.freeze([...this.#owners.values()].flatMap((values) => [...values]))
  }
}
