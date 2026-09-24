import type { Event } from '../../src/types.js'

// Counts every entry written into a Map or Set, by standing in for the global constructors while `run`
// executes. The constructors fill themselves through `set` and `add`, so an entry copied into a new
// table is counted along with one written into an existing table: a table rebuilt entry by entry is
// caught the same as one copied whole. Machine speed does not enter into it, so a bound on it holds in
// a loaded parallel test run as well as on a quiet one.
const RealMap = globalThis.Map
const RealSet = globalThis.Set
let copied = 0
class CountingMap<K, V> extends RealMap<K, V> {
  override set(key: K, value: V): this {
    copied++
    return super.set(key, value)
  }
}
class CountingSet<T> extends RealSet<T> {
  override add(value: T): this {
    copied++
    return super.add(value)
  }
}

/** The average number of Map and Set entries written per row while `run` consumes `rows`. */
export function copiedPerRow(rows: Iterable<Event>, run: (rows: Iterable<Event>) => void): number {
  let count = 0
  const counted = (function* () {
    for (const row of rows) {
      count++
      yield row
    }
  })()
  copied = 0
  globalThis.Map = CountingMap as MapConstructor
  globalThis.Set = CountingSet as SetConstructor
  try {
    run(counted)
  } finally {
    globalThis.Map = RealMap
    globalThis.Set = RealSet
  }
  return count === 0 ? 0 : copied / count
}
