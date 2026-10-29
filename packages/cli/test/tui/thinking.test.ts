import { assistantView, createAnsi, LiveView, TuiTheme, thinkingMode } from '@agnes/cli-tui'
import { afterEach, expect, it } from 'vitest'

const mono = new TuiTheme('mono').ansi(createAnsi('none'))
const thoughts = Array.from({ length: 8 }, (_, i) => `thought ${i + 1}`).join('\n')
const trimmed = (rows: string[]) => rows.map((r) => r.trimEnd())

afterEach(() => {
  thinkingMode.expanded = false
})

it('shows the last three screen rows of thoughts while streaming, then one folded line once the answer starts', () => {
  const live = new LiveView(mono, 'en')
  live.set([{ thinking: thoughts, text: '' }])
  expect(trimmed(live.render(40))).toEqual(['  thought 6', '  thought 7', '  thought 8'])
  live.set([{ thinking: thoughts, text: 'The answer' }])
  expect(trimmed(live.render(40))).toEqual(['∴ Reasoned (79 characters)', 'The answer'])
  live.set([{ thinking: '', text: 'plain' }])
  expect(live.render(40)).toEqual(['plain'])
})

it('counts wide characters by screen rows and removes control sequences from thoughts', () => {
  const live = new LiveView(mono, 'zh-CN')
  live.set([{ thinking: `${'思'.repeat(30)}\x1b[2J`, text: '' }])
  const rows = live.render(22) // 20 columns of text: 10 wide characters a row
  expect(rows).toHaveLength(3)
  expect(rows.join('')).not.toContain('\x1b')
  live.set([{ thinking: '想', text: '答' }])
  expect(trimmed(live.render(22))[0]).toBe('∴ 已思考（1 字）')
})

it('folds the thoughts of a finished reply above its text, and /thinking keeps them open', () => {
  const view = assistantView(
    { kind: 'assistant', id: 'a', seq: 1, text: 'done', thinking: thoughts },
    mono,
    'zh-CN',
  )
  expect(trimmed(view.render(40))).toEqual(['∴ 已思考（79 字）', 'done'])
  expect(trimmed(view.transcript?.(40) ?? [])).toEqual(['done'])
  thinkingMode.toggle()
  expect(trimmed(view.render(40)).slice(0, 2)).toEqual(['  thought 1', '  thought 2'])
  expect(trimmed(view.render(40)).at(-1)).toBe('done')
  // No thoughts, no row.
  expect(
    trimmed(assistantView({ kind: 'assistant', id: 'b', seq: 2, text: 'x' }, mono, 'en').render(40)),
  ).toEqual(['x'])
})

it("reuses a finished reply's Markdown rows across repaints until the width or theme changes", () => {
  const theme = new TuiTheme('dark')
  const base = theme.ansi(createAnsi('truecolor'))
  let paints = 0
  const ansi: typeof base = {
    ...base,
    fg: (c, text) => {
      paints++
      return base.fg(c, text)
    },
    get revision(): number {
      return base.revision ?? 0
    },
    get raw(): boolean {
      return base.raw ?? false
    },
  }
  const node = { kind: 'assistant', id: 'a', seq: 1, text: '# Title\n\n`code` and **bold**' } as const
  const view = assistantView(node, ansi, 'en')
  const first = view.render(40)
  expect(paints).toBeGreaterThan(0)
  paints = 0
  expect(view.render(40)).toEqual(first)
  expect(view.transcript?.(40)).toHaveLength(first.length)
  expect(paints).toBe(0)
  view.render(30)
  expect(paints).toBeGreaterThan(0)
  paints = 0
  theme.set('light')
  expect(view.render(30)).not.toEqual(first)
  expect(paints).toBeGreaterThan(0)
  paints = 0
  theme.raw = true
  view.render(30)
  expect(paints).toBeGreaterThan(0)
})
