import { escapeControl } from '../component.js'
import { fitLine } from '../components/line.js'
import { tt } from '../locale-extended.js'
import type { ThemedAnsi } from '../theme.js'

/** One replaced span of an `edit` call; `write` is a single hunk whose old side is empty. */
export type DiffHunk = { oldText: string; newText: string }
export type DiffInput = { path: string; hunks: DiffHunk[]; wholeFile: boolean }
type Op = { mark: ' ' | '+' | '-'; text: string; no: number }

// Old lines x new lines per hunk; past it the hunk is shown as "old block removed, new block added"
// instead of spending seconds (and tens of megabytes) on an exact line diff.
const MAX_CELLS = 2_500_000
/** Hunks diffed so far, for tests to tell a recomputation from a cache hit. */
export const diffWork = { hunks: 0 }
// Same fold rule as the Web conversation: a run of unchanged lines longer than FOLD_OVER keeps KEEP each side.
const FOLD_OVER = 8
const KEEP = 3

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** The diff an `edit` or `write` call describes, from its parsed arguments; anything else has none. */
export function diffInput(tool: string, args: unknown): DiffInput | undefined {
  const a = record(args)
  if (!a || typeof a.path !== 'string') return undefined
  if (tool === 'write' && typeof a.content === 'string')
    return { path: a.path, wholeFile: true, hunks: [{ oldText: '', newText: a.content }] }
  if (tool !== 'edit' || !Array.isArray(a.edits)) return undefined
  const hunks = a.edits.flatMap((e: unknown): DiffHunk[] => {
    const r = record(e)
    return typeof r?.oldText === 'string' && typeof r.newText === 'string'
      ? [{ oldText: r.oldText, newText: r.newText }]
      : []
  })
  return hunks.length > 0 ? { path: a.path, wholeFile: false, hunks } : undefined
}

/** `diffInput` over the JSON text of a call's arguments; text that is cut off or not JSON has none. */
export function diffFromArgsText(tool: string, text: string | undefined): DiffInput | undefined {
  if (text === undefined || (tool !== 'edit' && tool !== 'write')) return undefined
  try {
    return diffInput(tool, JSON.parse(text))
  } catch {
    return undefined
  }
}

const split = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

/** Line ops of one hunk: common ends trimmed, LCS on the middle, or a plain replace past the cap. */
function hunkOps(hunk: DiffHunk, budget: { cells: number }): Op[] {
  diffWork.hunks++
  const a = split(hunk.oldText)
  const b = split(hunk.newText)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail)) tail++
  const mid = { a: a.slice(head, a.length - tail), b: b.slice(head, b.length - tail) }
  const ops: Op[] = a.slice(0, head).map((text, i) => ({ mark: ' ', text, no: i + 1 }))
  let oldNo = head
  let newNo = head
  const del = (text: string) => ops.push({ mark: '-', text, no: ++oldNo })
  const add = (text: string) => ops.push({ mark: '+', text, no: ++newNo })
  const n = mid.a.length
  const m = mid.b.length
  // The cap is per hunk and also over the whole call: later hunks of a big edit fall back once it is spent.
  if (n * m > Math.min(MAX_CELLS, budget.cells)) {
    for (const text of mid.a) del(text)
    for (const text of mid.b) add(text)
  } else {
    budget.cells -= n * m
    // lcs[i][j]: length of the longest common subsequence of mid.a[i..] and mid.b[j..].
    const w = m + 1
    const lcs = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i * w + j] =
          mid.a[i] === mid.b[j]
            ? (lcs[(i + 1) * w + j + 1] as number) + 1
            : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number)
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && mid.a[i] === mid.b[j]) {
        oldNo++
        ops.push({ mark: ' ', text: mid.a[i] as string, no: ++newNo })
        i++
        j++
      } else if (j >= m || (i < n && (lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)))
        del(mid.a[i++] as string)
      else add(mid.b[j++] as string)
    }
  }
  for (const text of b.slice(b.length - tail)) ops.push({ mark: ' ', text, no: ++newNo })
  return ops
}

// Ops by content, a few at a time: a modal or card is drawn every frame, the diff is computed once.
const memo = new Map<string, Op[][]>()
const MEMO_SIZE = 16
const opsOf = (input: DiffInput): Op[][] => {
  const key = JSON.stringify(input.hunks)
  const known = memo.get(key)
  if (known) return known
  const budget = { cells: MAX_CELLS }
  const ops = input.hunks.map((hunk) => hunkOps(hunk, budget))
  memo.set(key, ops)
  if (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value as string)
  return ops
}

/** Added and removed line counts over every hunk, for the `+a -b` mark on a card title. */
export function diffStats(input: DiffInput): { added: number; removed: number } {
  const all = opsOf(input).flat()
  return {
    added: all.filter((op) => op.mark === '+').length,
    removed: all.filter((op) => op.mark === '-').length,
  }
}

/** Unchanged runs longer than FOLD_OVER keep KEEP lines beside a change; a number stands for that many hidden lines. */
function fold(ops: Op[]): Array<Op | number> {
  const out: Array<Op | number> = []
  for (let i = 0; i < ops.length; ) {
    const op = ops[i] as Op
    if (op.mark !== ' ') {
      out.push(op)
      i++
      continue
    }
    let end = i
    while (end < ops.length && ops[end]?.mark === ' ') end++
    const run = ops.slice(i, end)
    const before = i > 0 ? KEEP : 0
    const after = end < ops.length ? KEEP : 0
    if (run.length > FOLD_OVER)
      out.push(...run.slice(0, before), run.length - before - after, ...run.slice(run.length - after))
    else out.push(...run)
    i = end
  }
  return out
}

/** `+a -b` for a title, painted with the diff's own tones. */
export function statsMark(input: DiffInput, ansi: ThemedAnsi): string {
  const { added, removed } = diffStats(input)
  return `${ansi.fg('success', `+${added}`)} ${ansi.fg('danger', `-${removed}`)}`
}

/**
 * Rows for the diff of one call: the path, then every hunk with a gutter number (the old line for a
 * removal, the new one otherwise, counted from the start of the hunk because the call carries no file
 * offsets), a `+`/`-` mark and the text, clipped to `width` columns. All text is external.
 */
export function renderDiff(input: DiffInput, width: number, ansi: ThemedAnsi, locale: string): string[] {
  const hunks = opsOf(input)
  const digits = String(Math.max(1, ...hunks.flat().map((op) => op.no))).length
  const head = `${ansi.bold(escapeControl(input.path))}${input.wholeFile ? ` ${ansi.dim(tt('diff.wholeFile', locale))}` : ''} ${statsMark(input, ansi)}`
  const rows = [fitLine(head, width)]
  hunks.forEach((ops, h) => {
    if (h > 0) rows.push(fitLine(ansi.fg('faint', ' ╌╌╌'), width))
    for (const item of fold(ops)) {
      if (typeof item === 'number') {
        rows.push(
          fitLine(
            ansi.fg('faint', ` ${' '.repeat(digits)}   ${tt('diff.unchanged', locale, { n: item })}`),
            width,
          ),
        )
        continue
      }
      const text = escapeControl(item.text.replaceAll('\t', '  '))
      const line = ` ${String(item.no).padStart(digits)} ${item.mark} ${text}`
      rows.push(
        fitLine(
          item.mark === '+'
            ? ansi.fg('success', line)
            : item.mark === '-'
              ? ansi.fg('danger', line)
              : ansi.dim(line),
          width,
        ),
      )
    }
  })
  return rows
}
