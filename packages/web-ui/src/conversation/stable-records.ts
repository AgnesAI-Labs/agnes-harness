/** Exact comparison of protocol JSON values; never use sampled text fingerprints. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = Object.keys(a)
  const right = Object.keys(b)
  return (
    left.length === right.length &&
    left.every((key) => Object.hasOwn(b, key) && sameValue(Reflect.get(a, key), Reflect.get(b, key)))
  )
}

/** Retain unchanged JSON record identities, bounded to this window. Own copies also detect caller edits. */
export function stableRecords<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
): readonly T[] {
  const known = new Map(previous.map((record) => [record.id, record]))
  const shared = next.map((record) => {
    const before = known.get(record.id)
    return before && sameValue(before, record) ? before : structuredClone(record)
  })
  return previous.length === shared.length && shared.every((record, i) => record === previous[i])
    ? previous
    : shared
}
