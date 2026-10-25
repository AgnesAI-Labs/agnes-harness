import {
  createAnsi,
  diffInput,
  diffStats,
  diffWork,
  displayWidth,
  renderDiff,
  TuiTheme,
} from '@agnes/cli-tui'
import { expect, it } from 'vitest'

const mono = new TuiTheme('mono').ansi(createAnsi('none'))
const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n')
const draw = (tool: string, args: unknown, width = 60, locale = 'zh-CN') => {
  const input = diffInput(tool, args)
  if (!input) throw new Error('no diff')
  return renderDiff(input, width, mono, locale)
}

it('diffs every edit of a call as its own hunk and counts the changed lines', () => {
  const args = {
    path: 'a.ts',
    edits: [
      { oldText: 'one\ntwo\nthree', newText: 'one\n2\nthree\nfour' },
      { oldText: 'x', newText: 'y' },
    ],
  }
  const rows = draw('edit', args)
  expect(rows.map((r) => r.trimEnd())).toEqual([
    'a.ts +3 -2',
    ' 1   one',
    ' 2 - two',
    ' 2 + 2',
    ' 3   three',
    ' 4 + four',
    ' ╌╌╌',
    ' 1 - x',
    ' 1 + y',
  ])
  expect(diffStats(diffInput('edit', args) as never)).toEqual({ added: 3, removed: 2 })
  expect(rows.every((r) => displayWidth(r) === 60)).toBe(true)
})

it('shows a write as all additions and ignores other tools and malformed arguments', () => {
  expect(draw('write', { path: 'n.txt', content: 'a\nb\n' }).map((r) => r.trimEnd())).toEqual([
    'n.txt 整文件写入，已存在则覆盖 +2 -0',
    ' 1 + a',
    ' 2 + b',
  ])
  expect(diffInput('read', { path: 'a' })).toBeUndefined()
  expect(diffInput('edit', { path: 'a', edits: [{ oldText: 1 }] })).toBeUndefined()
  expect(diffInput('write', 'nope')).toBeUndefined()
})

it('folds long unchanged runs to three lines beside each change', () => {
  const rows = draw('edit', {
    path: 'a',
    edits: [
      { oldText: `${lines(20)}\nOLD\n${lines(9, 'z')}`, newText: `${lines(20)}\nNEW\n${lines(9, 'z')}` },
    ],
  }).map((r) => r.trimEnd())
  expect(rows).toEqual([
    'a +1 -1',
    '      ⋯ 17 行未变',
    ' 18   l18',
    ' 19   l19',
    ' 20   l20',
    ' 21 - OLD',
    ' 21 + NEW',
    ' 22   z1',
    ' 23   z2',
    ' 24   z3',
    '      ⋯ 6 行未变',
  ])
  // A short run stays whole.
  expect(
    draw('edit', { path: 'a', edits: [{ oldText: `${lines(8)}\nA`, newText: `${lines(8)}\nB` }] }),
  ).toHaveLength(11)
})

it('falls back to replacing the block for oversize hunks instead of hanging', () => {
  const start = Date.now()
  const rows = draw('edit', {
    path: 'big',
    edits: [{ oldText: lines(2000, 'o'), newText: lines(2000, 'n') }],
  })
  expect(Date.now() - start).toBeLessThan(3000)
  expect(rows[0]).toContain('+2000 -2000')
  expect(rows[1]).toContain('- o1')
  expect(rows[2000]).toContain('- o2000')
  expect(rows[2001]).toContain('+ n1')
})

it('removes control sequences, expands tabs and clips long lines to the width', () => {
  const rows = draw('write', { path: 'p\x1b[2J', content: `a\x1b[31m\tb\n${'中'.repeat(100)}` }, 30)
  expect(rows.join('\n')).not.toContain('\x1b')
  expect(rows[1]).toContain('a[31m  b')
  expect(rows.every((r) => displayWidth(r) === 30)).toBe(true)
  expect(rows[2]).toContain('…')
})

it('spells out bidi and zero-width characters in diff lines and keeps word marks aligned', () => {
  const ansi = new TuiTheme('dark').ansi(createAnsi('256'))
  const mark = (s: string) => ansi.bold(ansi.underline(s))
  const edit = (oldText: string, newText: string) =>
    renderDiff(diffInput('edit', { path: 'a', edits: [{ oldText, newText }] }) as never, 600, ansi, 'en')
  const rows = edit('if (user\u202E\u2066 == "admin") {', 'if (user\u202E\u2066 == "root") {').join('\n')
  expect(rows).not.toMatch(/[\u202E\u2066]/)
  expect(rows).toContain('user\\u{202E}\\u{2066} == "')
  expect(rows).toContain(mark('root'))
})

it('paints removals and additions with the danger and success tones', () => {
  const ansi = new TuiTheme('dark').ansi(createAnsi('256'))
  const input = diffInput('edit', { path: 'a', edits: [{ oldText: 'x', newText: 'y' }] })
  const rows = renderDiff(input as never, 40, ansi, 'en')
  expect(rows[1]).toContain(ansi.fg('danger', ' 1 - x'))
  expect(rows[2]).toContain(ansi.fg('success', ' 1 + y'))
})

it('computes the ops of a call once however often it is drawn, and spends one budget across its hunks', () => {
  const edits = [{ oldText: 'p\nq', newText: 'p\nr' }]
  const before = diffWork.hunks
  for (const width of [40, 60, 40]) draw('edit', { path: 'same.ts', edits }, width)
  expect(diffWork.hunks - before).toBe(1)
  // Three hunks of 1000 x 1000 lines: the first two fit 2.5M cells together, the third falls back.
  const hunk = (tag: string) => ({ oldText: lines(1000, `${tag}o`), newText: lines(1000, `${tag}n`) })
  const many = { path: 'many', edits: [hunk('a'), hunk('b'), hunk('c')] }
  const start = Date.now()
  const rows = draw('edit', many)
  expect(Date.now() - start).toBeLessThan(5000)
  expect(rows[0]).toContain('+3000 -3000')
  expect(rows.some((row) => row.includes('- co1000'))).toBe(true)
})

it('marks the changed words of an edited line, and only on paired lines', () => {
  const ansi = new TuiTheme('dark').ansi(createAnsi('256'))
  const mark = (s: string) => ansi.bold(ansi.underline(s))
  const edit = (oldText: string, newText: string) =>
    renderDiff(diffInput('edit', { path: 'a', edits: [{ oldText, newText }] }) as never, 600, ansi, 'en')
  const rows = edit('const total = price * 2', 'const total = cost * 2')
  expect(rows[1]).toContain(`const total = ${mark('price')} * 2`)
  expect(rows[2]).toContain(`const total = ${mark('cost')} * 2`)
  // An added line with no removed partner, a pair with nothing in common and a long line stay line-level.
  const fresh = renderDiff(diffInput('write', { path: 'n', content: 'x y' }) as never, 60, ansi, 'en')
  expect(fresh.join('')).not.toContain('\x1b[1m\x1b[4m')
  expect(edit('alpha beta', 'gamma delta').join('')).not.toContain('\x1b[1m\x1b[4m')
  const long = `${'word '.repeat(110)}end`
  expect(edit(long, `${long}!`).join('')).not.toContain('\x1b[1m\x1b[4m')
})

it('draws a diff with hundreds of thousands of lines without overflowing the argument limit', () => {
  const rows = draw('write', { path: 'huge.txt', content: lines(300_000) })
  expect(rows[0]).toContain('+300000 -0')
})

it('shows an edit that only adds or removes the final newline the way git does', () => {
  const edit = (oldText: string, newText: string) =>
    draw('edit', { path: 'n', edits: [{ oldText, newText }] }).map((r) => r.trimEnd())
  expect(edit('a\nb', 'a\nb\n')).toEqual([
    'n +1 -1',
    ' 1   a',
    ' 2 - b',
    ' 2   \\ No newline at end of file',
    ' 2 + b',
  ])
  expect(edit('a\nb\n', 'a\nb')).toEqual([
    'n +1 -1',
    ' 1   a',
    ' 2 - b',
    ' 2 + b',
    ' 2   \\ No newline at end of file',
  ])
})
