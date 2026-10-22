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
  expect(trimmed(live.render(40))).toEqual(['✻ Thought (79 characters)', 'The answer'])
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
  expect(trimmed(live.render(22))[0]).toBe('✻ 已思考（1 字）')
})

it('folds the thoughts of a finished reply above its text, and /thinking keeps them open', () => {
  const view = assistantView(
    { kind: 'assistant', id: 'a', seq: 1, text: 'done', thinking: thoughts },
    mono,
    'zh-CN',
  )
  expect(trimmed(view.render(40))).toEqual(['', '✻ 已思考（79 字）', 'done'])
  expect(trimmed(view.transcript?.(40) ?? [])).toEqual(['done'])
  thinkingMode.toggle()
  expect(trimmed(view.render(40)).slice(1, 3)).toEqual(['  thought 1', '  thought 2'])
  expect(trimmed(view.render(40)).at(-1)).toBe('done')
  // No thoughts, no row.
  expect(
    trimmed(assistantView({ kind: 'assistant', id: 'b', seq: 2, text: 'x' }, mono, 'en').render(40)),
  ).toEqual(['', 'x'])
})
