/** One row of a rendered unified diff. `old`/`new` are line numbers on each side, when the row has one. */
export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'del' | 'ctx'; text: string; old?: number; new?: number }
  | { kind: 'fold'; id: string; hidden: DiffRow[] }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/**
 * Parse the unified diff the review service returns. File headers (`---`/`+++`) are dropped; a hunk
 * header restarts both line counters. A diff without hunk headers (a whole new file) counts from 1.
 */
export function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  let left = 1,
    right = 1,
    inHunk = false
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ ') || line === '---' || line === '+++'))
      continue
    const hunk = HUNK.exec(line)
    if (hunk) {
      inHunk = true
      left = Number(hunk[1])
      right = Number(hunk[2])
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), new: right++ })
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), old: left++ })
    else
      rows.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, old: left++, new: right++ })
  }
  return rows
}

/** Unchanged runs longer than this fold to their first and last lines. */
const CONTEXT_RUN = 8
const CONTEXT_KEEP = 3
/** A long diff shows this many rows before one fold for the rest. */
const LONG_DIFF = 400

/** Fold long unchanged runs, then the tail of a very long diff. Each fold is opened by its id. */
export function foldDiff(rows: readonly DiffRow[], opened: ReadonlySet<string>): DiffRow[] {
  const out: DiffRow[] = []
  let run: DiffRow[] = [],
    start = 0
  const flush = () => {
    // Named by where the run starts in the diff, so opening one fold never renames another.
    const id = `ctx:${start}`
    if (run.length > CONTEXT_RUN && !opened.has(id))
      out.push(
        ...run.slice(0, CONTEXT_KEEP),
        { kind: 'fold', id, hidden: run.slice(CONTEXT_KEEP, -CONTEXT_KEEP) },
        ...run.slice(-CONTEXT_KEEP),
      )
    else out.push(...run)
    run = []
  }
  rows.forEach((row, index) => {
    if (row.kind === 'ctx') {
      if (!run.length) start = index
      run.push(row)
    } else {
      flush()
      out.push(row)
    }
  })
  flush()
  if (out.length > LONG_DIFF && !opened.has('tail'))
    return [...out.slice(0, LONG_DIFF), { kind: 'fold', id: 'tail', hidden: out.slice(LONG_DIFF) }]
  return out
}

/** The lines a diff shows from one side: before = unchanged + removed, after = unchanged + added. */
export function diffSide(rows: readonly DiffRow[], side: 'before' | 'after'): DiffRow[] {
  return rows.flatMap((row): DiffRow[] => {
    if (row.kind === 'hunk' || row.kind === 'fold') return [row]
    if (row.kind === 'ctx') return [{ kind: 'ctx', text: row.text, ...sideNumber(row, side) }]
    if (side === 'before' && row.kind === 'del')
      return [{ kind: 'del', text: row.text, ...sideNumber(row, side) }]
    if (side === 'after' && row.kind === 'add')
      return [{ kind: 'add', text: row.text, ...sideNumber(row, side) }]
    return []
  })
}
const sideNumber = (row: { old?: number; new?: number }, side: 'before' | 'after') =>
  side === 'before'
    ? row.old === undefined
      ? {}
      : { old: row.old }
    : row.new === undefined
      ? {}
      : { new: row.new }

/** Plain text as unchanged rows, numbered from 1. */
export function textRows(text: string): DiffRow[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line, index) => ({ kind: 'ctx', text: line, new: index + 1 }))
}
