const CHUNK = 256

/**
 * An insertion-ordered map that is never changed once built: `set` returns a new map that shares every
 * chunk it did not touch with this one. Entries live in chunks of at most 256, so a write copies the
 * chunk list and one chunk rather than every entry, and a state that holds an earlier map keeps seeing
 * exactly what it saw. Iteration order is the order a plain Map would have: an overwritten key keeps
 * its place. There is no delete; the ledger tables built on it only grow, and a fork starts from an
 * empty one. JSON.stringify and structuredClone do not see it as a Map, so ledger state holding one is
 * compared or serialized by encoding its entries explicitly, never by passing it to either directly.
 */
export class ChunkedMap<K, V> implements ReadonlyMap<K, V> {
  readonly #chunks: readonly ReadonlyMap<K, V>[]
  readonly size: number

  private constructor(chunks: readonly ReadonlyMap<K, V>[], size: number) {
    this.#chunks = chunks
    this.size = size
  }

  static empty<K, V>(): ChunkedMap<K, V> {
    return new ChunkedMap<K, V>([], 0)
  }

  /** Builds a map from entries in one pass; a repeated key updates its first place, as Map does. */
  static from<K, V>(entries: Iterable<readonly [K, V]>): ChunkedMap<K, V> {
    const chunks: Map<K, V>[] = []
    const home = new Map<K, number>()
    for (const [key, value] of entries) {
      const at = home.get(key)
      if (at !== undefined) {
        chunks[at]?.set(key, value)
        continue
      }
      let last = chunks.at(-1)
      if (!last || last.size >= CHUNK) {
        last = new Map()
        chunks.push(last)
      }
      last.set(key, value)
      home.set(key, chunks.length - 1)
    }
    return new ChunkedMap<K, V>(chunks, home.size)
  }

  #find(key: K): number {
    for (let i = this.#chunks.length - 1; i >= 0; i--) if (this.#chunks[i]?.has(key)) return i
    return -1
  }

  get(key: K): V | undefined {
    const i = this.#find(key)
    return i < 0 ? undefined : this.#chunks[i]?.get(key)
  }

  has(key: K): boolean {
    return this.#find(key) >= 0
  }

  set(key: K, value: V): ChunkedMap<K, V> {
    const chunks = this.#chunks.slice()
    const i = this.#find(key)
    if (i >= 0) {
      chunks[i] = new Map(chunks[i]).set(key, value)
      return new ChunkedMap(chunks, this.size)
    }
    const last = chunks.at(-1)
    if (last && last.size < CHUNK) chunks[chunks.length - 1] = new Map(last).set(key, value)
    else chunks.push(new Map([[key, value]]))
    return new ChunkedMap(chunks, this.size + 1)
  }

  *#walk(): Generator<[K, V]> {
    for (const chunk of this.#chunks) yield* chunk
  }

  entries(): MapIterator<[K, V]> {
    return this.#walk() as unknown as MapIterator<[K, V]>
  }

  keys(): MapIterator<K> {
    const walk = this.#walk()
    return (function* () {
      for (const [key] of walk) yield key
    })() as unknown as MapIterator<K>
  }

  values(): MapIterator<V> {
    const walk = this.#walk()
    return (function* () {
      for (const [, value] of walk) yield value
    })() as unknown as MapIterator<V>
  }

  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#walk()) callback.call(thisArg, value, key, this)
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries()
  }
}

/**
 * The set counterpart of ChunkedMap: `add` returns a new set sharing every untouched chunk. Like
 * ChunkedMap, it is not a Set to JSON.stringify or structuredClone; encode its entries explicitly.
 */
export class ChunkedSet<T> implements ReadonlySet<T> {
  readonly #map: ChunkedMap<T, true>

  private constructor(map: ChunkedMap<T, true>) {
    this.#map = map
  }

  static empty<T>(): ChunkedSet<T> {
    return new ChunkedSet<T>(ChunkedMap.empty())
  }

  static from<T>(values: Iterable<T>): ChunkedSet<T> {
    const entries = (function* () {
      for (const value of values) yield [value, true] as const
    })()
    return new ChunkedSet(ChunkedMap.from<T, true>(entries))
  }

  get size(): number {
    return this.#map.size
  }

  has(value: T): boolean {
    return this.#map.has(value)
  }

  add(value: T): ChunkedSet<T> {
    return this.#map.has(value) ? this : new ChunkedSet(this.#map.set(value, true))
  }

  keys(): SetIterator<T> {
    return this.#map.keys() as unknown as SetIterator<T>
  }

  values(): SetIterator<T> {
    return this.keys()
  }

  entries(): SetIterator<[T, T]> {
    const keys = this.#map.keys()
    return (function* () {
      for (const key of keys) yield [key, key] as [T, T]
    })() as unknown as SetIterator<[T, T]>
  }

  forEach(callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const key of this.#map.keys()) callback.call(thisArg, key, key, this)
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.keys()
  }
}
