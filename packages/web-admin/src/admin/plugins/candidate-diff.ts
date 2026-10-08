export type DiffLine = { kind: 'context' | 'added' | 'removed'; text: string }

/** Keep unchanged lines aligned; bound the comparison for large generated files. */
export function candidateDiff(before: string | null, after: string | null): DiffLine[] {
  const old = before === null ? [] : before.split('\n'),
    next = after === null ? [] : after.split('\n')
  let start = 0,
    end = 0
  while (start < old.length && start < next.length && old[start] === next[start]) start++
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - end - 1] === next[next.length - end - 1]
  )
    end++
  const a = old.slice(start, old.length - end),
    b = next.slice(start, next.length - end)
  const lines: DiffLine[] = old.slice(0, start).map((text) => ({ kind: 'context', text }))
  if ((a.length + 1) * (b.length + 1) > 250_000) {
    // A coarse replacement still displays every removed and added line without quadratic work.
    for (const text of a) lines.push({ kind: 'removed', text })
    for (const text of b) lines.push({ kind: 'added', text })
  } else {
    const width = b.length + 1,
      lengths = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        lengths[i * width + j] =
          a[i] === b[j]
            ? 1 + lengths[(i + 1) * width + j + 1]!
            : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!)
    let i = 0,
      j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        lines.push({ kind: 'context', text: a[i++]! })
        j++
      } else if (
        i < a.length &&
        (j === b.length || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)
      )
        lines.push({ kind: 'removed', text: a[i++]! })
      else lines.push({ kind: 'added', text: b[j++]! })
    }
  }
  for (const text of old.slice(old.length - end)) lines.push({ kind: 'context', text })
  return lines
}
