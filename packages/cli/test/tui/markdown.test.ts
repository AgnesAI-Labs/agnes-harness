import { stripVTControlCharacters } from 'node:util'
import { expect, it } from 'vitest'
import { createAnsi } from '../../src/tui/ansi.js'
import { renderMarkdown } from '../../src/tui/markdown.js'
import { displayWidth } from '../../src/tui/terminal.js'
import { TuiTheme } from '../../src/tui/theme.js'

const none = new TuiTheme('mono').ansi(createAnsi('none'))
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
    `${'  const x = 1'.padEnd(36)} js `,
    '',
    '│ k  │ v │',
    '├────┼───┤',
    '│ 中 │ 1 │',
    '',
    '<b>raw</b> alt',
  ])
})
it('paints every Markdown role through its theme tone, and mono through weight and glyph only', () => {
  const t = new TuiTheme('light').ansi(createAnsi('256'))
  const md =
    '# One\n\n## Two\n\n### Three\n\n*em* `x` [docs](https://d.example) <https://a.example>\n\n- a\n\n1. b\n\n> q\n\n```sh\nrun\n```\n\n| k |\n|---|\n| v |\n\n---'
  expect(renderMarkdown(md, 40, t)).toEqual([
    t.bold(t.fg('accent', 'One')),
    '',
    t.bold('Two'),
    '',
    t.bold(t.fg('muted', 'Three')),
    '',
    `${t.italic('em')} ${t.bg('codeBg', t.fg('code', ' x '))} ${t.underline(t.fg('link', 'docs'))}${t.fg('faint', ' (https://d.example)')}`,
    t.underline(t.fg('link', 'https://a.example')),
    '',
    `${t.fg('accentSoft', '•')} a`,
    '',
    `${t.fg('muted', '1.')} b`,
    '',
    `${t.fg('accentSoft', '▎')} ${t.italic(t.fg('muted', 'q'))}`,
    '',
    t.bg('surface', t.fg('surfaceFg', '  run'.padEnd(36)) + t.fg('faint', ' sh ')),
    '',
    `${t.fg('border', '│')} ${t.bold('k')} ${t.fg('border', '│')}`,
    t.fg('border', '├───┤'),
    `${t.fg('border', '│')} v ${t.fg('border', '│')}`,
    '',
    t.fg('border', '─'.repeat(40)),
  ])
  const mono = new TuiTheme('mono').ansi(createAnsi('256'))
  expect(renderMarkdown('# One\n\n`x`\n\n```\nrun\n```', 10, mono)).toEqual([
    mono.bold('One'),
    '',
    'x',
    '',
    mono.dim('  run'),
  ])
})
it('removes untrusted VT sequences and control bytes before styling', () => {
  expect(renderMarkdown('a\x1b[31mb\x07c', 20, none)).toEqual(['abc'])
  expect(renderMarkdown('before\x1b]52;c;YQ==\x07after\x1b[2J\x00', 40, none)).toEqual(['beforeafter'])
  expect(renderMarkdown('a\x9b31mb\x9d52;c;YQ==\x9cc', 40, none)).toEqual(['abc'])
  expect(renderMarkdown('a\x1bPpayload\x1b\\b\x1b]unfinished', 40, none)).toEqual(['ab'])
})
it('balances emphasis separately on each wrapped line and preserves graphemes', () => {
  const lines = renderMarkdown('**ab中é👩‍💻z**', 4, new TuiTheme('light').ansi(createAnsi('16')))
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
    '▎ quoted',
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

const dark = new TuiTheme('dark').ansi(createAnsi('256'))
const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``

it('colours strings, comments, numbers and keywords of a code block and nothing else', () => {
  const [line] = renderMarkdown(fence('js', 'const n = 42 // "x"'), 60, dark)
  expect(line).toContain(dark.fg('accent', 'const'))
  expect(line).toContain(dark.fg('warning', '42'))
  expect(line).toContain(dark.fg('faint', '// "x"')) // a string inside a comment is comment
  const [text] = renderMarkdown(fence('py', 's = "a#b" # c'), 60, dark)
  expect(text).toContain(dark.fg('success', '"a#b"'))
  expect(text).toContain(dark.fg('faint', '# c'))
  // A block comment spans lines; an unknown language label is coloured the same way.
  const rows = renderMarkdown(fence('klingon', '/* a\nreturn */ return 1'), 40, dark)
  expect(rows[0]).toContain(dark.fg('faint', '/* a'))
  expect(rows[1]).toContain(dark.fg('faint', 'return */'))
  expect(rows[1]).toContain(dark.fg('accent', 'return'))
})

it('keeps the code text exactly: stripping the colours gives the uncoloured block', () => {
  const sources = [
    "const s = `a\n{b}` + 'it\\'s' + \"unterminated",
    'fn main() { println!("中文 {}", 1.5e3); } // 注释',
    '/* open\nstill open',
    'x = """doc\nstring"""\n\treturn None',
    '#!/bin/sh\nif [ -z "$1" ]; then echo 0x1F; fi',
    'a'.repeat(200),
  ]
  for (const lang of ['', 'js', 'python', 'sql', 'whatever'])
    for (const width of [6, 24, 80])
      for (const src of sources) {
        const colour = renderMarkdown(fence(lang, src), width, dark).map((row) =>
          stripVTControlCharacters(row).trimEnd(),
        )
        const plainRows = renderMarkdown(
          fence(lang, src),
          width,
          new TuiTheme('dark').ansi(createAnsi('none')),
        ).map((row) => row.trimEnd())
        expect(colour).toEqual(plainRows)
      }
})

it('draws a block of more than 2000 lines in the block colour only', () => {
  const big = Array.from({ length: 2001 }, () => 'return 1').join('\n')
  const rows = renderMarkdown(fence('js', big), 30, dark)
  expect(rows).toHaveLength(2001)
  expect(rows.some((row) => row.includes(dark.fg('accent', 'return')))).toBe(false)
  expect(renderMarkdown(fence('js', 'return 1'), 30, dark)[0]).toContain(dark.fg('accent', 'return'))
})

it('leaves oversize or pathological code uncoloured and finishes quickly', () => {
  const start = Date.now()
  for (const body of [
    'x'.repeat(200_001),
    '/*'.repeat(100_000),
    '`"\''.repeat(30_000),
    '"a'.repeat(90_000),
  ]) {
    const rows = renderMarkdown(fence('js', body), 40, dark)
    expect(rows.map((row) => stripVTControlCharacters(row).trim()).join('')).toContain(
      body.slice(0, 20).trim(),
    )
  }
  expect(Date.now() - start).toBeLessThan(5000)
  expect(renderMarkdown(fence('js', `${'x'.repeat(200_001)} return`), 40, dark)[0]).not.toContain(
    dark.fg('accent', 'return'),
  )
})

it('raw view: a fence is its language line and the code itself, a quote has no bar, and no character is lost', () => {
  const theme = new TuiTheme('dark')
  const ansi = theme.ansi(createAnsi('256'))
  const md = `> quoted\n\n\`\`\`ts\nconst a = 1\n    indented(${'x'.repeat(50)})\n\`\`\`\n\n\`\`\`\nbare\n\`\`\``
  const styled = renderMarkdown(md, 30, ansi).map((row) => stripVTControlCharacters(row))
  expect(styled.join('\n')).toContain('▎ quoted')
  expect(styled.join('\n')).toContain('  const a = 1')
  theme.raw = true
  const raw = renderMarkdown(md, 30, ansi).map((row) => stripVTControlCharacters(row))
  expect(raw[0]).toBe('quoted')
  expect(raw.slice(1)).toEqual([
    '',
    'ts',
    'const a = 1',
    `    indented(${'x'.repeat(17)}`,
    'x'.repeat(30),
    'xxx)',
    '',
    'bare',
  ])
  expect(raw.every((row) => displayWidth(row) <= 30)).toBe(true)
})

it('shows LaTeX as Unicode, keeps prices, shell variables and code spans as written, and shows source in /raw', () => {
  const theme = new TuiTheme('light')
  const ansi = theme.ansi(createAnsi('256'))
  const text = (md: string) => renderMarkdown(md, 40, ansi).map((row) => stripVTControlCharacters(row))
  expect(text('```math\n\\frac{a+b}{2} \\le x^2\n```')).toEqual(['  (a+b)/2 ≤ x²'])
  expect(text('before\n\n$$\n\\alpha_i \\times \\sqrt{n}\n$$\n\nafter')).toEqual([
    'before',
    '',
    '  αᵢ × √n',
    '',
    'after',
  ])
  expect(text('\\[ E = mc^2 \\]')).toEqual(['  E = mc²'])
  expect(text('so \\(a \\le b\\) holds, and $x^2$ too')).toEqual(['so a ≤ b holds, and x² too'])
  expect(text('$5 and $10, cost $HOME, `$x^2$`')).toEqual(['$5 and $10, cost $HOME,  $x^2$'])
  expect(text('escaped \\$x^2$ stays')).toEqual(['escaped $x^2$ stays'])
  // an unknown command keeps the whole formula as written
  expect(text('see $\\nosuch x^2$ here')).toEqual(['see $\\nosuch x^2$ here'])
  expect(text('$$\n\\nosuch{x}\n$$')).toEqual([expect.stringContaining('\\nosuch{x}')])
  // streaming: an unclosed $$ is plain text until it closes
  expect(text('$$\nx^2')).toEqual(['$$', 'x^2'])
  // the converted formula is painted in the accent tone, the source is not
  expect(renderMarkdown('$x^2$', 20, ansi)[0]).toBe(ansi.fg('accent', 'x²'))
  const mono = new TuiTheme('mono').ansi(createAnsi('256'))
  expect(renderMarkdown('$x^2$ and\n\n$$\\alpha$$', 20, mono)).toEqual(['x² and', '', '  α'])
  theme.raw = true
  expect(text('$x^2$ and \\(a \\le b\\)\n\n$$\\alpha$$')).toEqual([
    '$x^2$ and \\(a \\le b\\)',
    '',
    '$$\\alpha$$',
  ])
  expect(text('```math\n\\alpha\n```')).toEqual(['math', '\\alpha'])
})
