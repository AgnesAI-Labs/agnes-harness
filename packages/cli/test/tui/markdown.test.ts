import { stripVTControlCharacters } from 'node:util'
import { expect, it } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { renderMarkdown } from '../../src/tui/markdown.js'
import { displayWidth } from '../../src/tui/terminal.js'

const none = createAnsi('none')
it('renders headings, emphasis, lists, fences, tables and literal HTML without image fetching', () => {
  const md =
    '# Title\n\npara **bold**\n\n- a\n- b\n\n```js\nconst x = 1\n```\n\n| k | v |\n|---|---|\n| 中 | 1 |\n\n<b>raw</b> ![alt](http://x/y.png)'
  expect(renderMarkdown(md, 40, none)).toEqual([
    'Title',
    '',
    'para bold',
    '',
    '• a',
    '• b',
    '',
    '  const x = 1',
    '',
    '│ k  │ v │',
    '│ 中 │ 1 │',
    '',
    '<b>raw</b> alt',
  ])
})
it('removes untrusted VT sequences and control bytes before styling', () => {
  expect(renderMarkdown('a\x1b[31mb\x07c', 20, none)).toEqual(['abc'])
  expect(renderMarkdown('before\x1b]52;c;YQ==\x07after\x1b[2J\x00', 40, none)).toEqual(['beforeafter'])
  expect(renderMarkdown('a\x9b31mb\x9d52;c;YQ==\x9cc', 40, none)).toEqual(['abc'])
  expect(renderMarkdown('a\x1bPpayload\x1b\\b\x1b]unfinished', 40, none)).toEqual(['ab'])
})
it('balances emphasis separately on each wrapped line and preserves graphemes', () => {
  const lines = renderMarkdown('**ab中é👩‍💻z**', 4, createAnsi('16'))
  expect(lines.map(stripVTControlCharacters)).toEqual(['ab中', 'é', '👩‍💻', 'z'])
  for (const line of lines) {
    expect(line.startsWith('\x1b[1m')).toBe(true)
    expect(line.endsWith('\x1b[22m')).toBe(true)
    expect(displayWidth(line)).toBeLessThanOrEqual(4)
  }
})
it('clips code by display width without breaking a grapheme', () => {
  expect(renderMarkdown('```\né中long\n```', 6, none)).toEqual(['  é中…'])
  expect(renderMarkdown('中', 1, none)).toEqual(['…'])
})
it('retains table content within narrow widths, including a header-only table', () => {
  const md = '| name | value |\n|---|---|\n| abcd | 中国 |'
  for (const width of [1, 4, 9, 12, 20]) {
    const lines = renderMarkdown(md, width, none)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => displayWidth(line) <= width)).toBe(true)
  }
  expect(renderMarkdown('| name | value |\n|---|---|', 5, none)).toEqual(['name', 'value'])
  expect(renderMarkdown(md, 6, none)).toEqual(['name:', 'abcd', 'value:', '中国'])
})
it('renders nested and zero-start ordered lists and blockquotes at the available width', () => {
  expect(renderMarkdown('0. first\n1. second\n\n> quoted\n\n- top\n  - child', 20, none)).toEqual([
    '0. first',
    '1. second',
    '',
    '> quoted',
    '',
    '• top',
    '  • child',
  ])
})
it('handles empty content and rejects non-finite dimensions', () => {
  expect(renderMarkdown('', 20, none)).toEqual([])
  expect(renderMarkdown('abc', 0, none)).toEqual(['a', 'b', 'c'])
  expect(() => renderMarkdown('x', Number.NaN, none)).toThrow('invalid markdown width')
})
