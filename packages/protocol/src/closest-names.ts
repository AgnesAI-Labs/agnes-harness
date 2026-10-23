/** Levenshtein distance between two strings, counted in UTF-16 units. */
export function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    row = next
  }
  return row[b.length] ?? 0
}

/**
 * The known names a mistyped one most likely meant, nearest first, at most `limit`. A name qualifies
 * within a third of the input's length in edits (at least one), compared without case; ties keep the
 * order of `candidates`. Input shorter than two characters matches nothing, since every name is
 * "one edit away" from it.
 */
export function closestNames(input: string, candidates: Iterable<string>, limit = 1): string[] {
  const want = input.toLowerCase()
  if (want.length < 2) return []
  const max = Math.max(1, Math.floor(want.length / 3))
  return [...candidates]
    .map((name, order) => ({ name, order, d: editDistance(want, name.toLowerCase()) }))
    .filter((c) => c.d <= max && c.name.toLowerCase() !== want)
    .sort((x, y) => x.d - y.d || x.order - y.order)
    .slice(0, limit)
    .map((c) => c.name)
}
