import { Lexer, type Token, type Tokens } from 'marked'
import { type CodeRun, highlight } from './highlight.js'
import { renderLatex } from './latex.js'
import { displayMathSource, MATH_FENCES, mathLexerOptions } from './latex-markdown.js'
import { fenceClosed, mermaidBlock } from './mermaid.js'
import type { Tone } from './palette.js'
import { displayWidth } from './terminal.js'
import type { ThemedAnsi } from './theme.js'

/** How a run of text is drawn. Spans that share one object are painted as one SGR run. */
type Style = Readonly<{ bold?: true; italic?: true; code?: true; link?: true; tone?: Tone }>
type Span = { text: string; style: Style }
const PLAIN: Style = {}
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// VT sequences are removed first, including their parameters; these are remaining control bytes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: remove untrusted terminal controls
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
const span = (text: string, style: Style = PLAIN): Span => ({ text, style })
const plain = (spans: Span[]) => spans.map((part) => part.text).join('')
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - displayWidth(text)))
const HEADING: Record<number, Style> = { 1: { bold: true, tone: 'accent' }, 2: { bold: true } }
// Inline-code padding and the code-block text colour only make sense where a background paints;
// mono and colourless tiers keep the code text unpadded and fall back to dim.
const shades = (ansi: ThemedAnsi) => ansi.bg('codeBg', ' ') !== ' '

/** Consume terminal commands without allowing an OSC terminator to swallow preceding CSI text. */
export function stripVT(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i)
    if (code === 0x1b) {
      code = text.charCodeAt(++i)
      if (code >= 0x40 && code <= 0x5f) code += 0x40
      else {
        // ESC intermediates followed by a final byte (e.g. character-set selection).
        while (code >= 0x20 && code <= 0x2f) code = text.charCodeAt(++i)
        continue
      }
    }
    if (code === 0x9b) {
      while (i + 1 < text.length) {
        const next = text.charCodeAt(++i)
        if (next >= 0x40 && next <= 0x7e) break
      }
    } else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
      while (i + 1 < text.length) {
        const next = text.charCodeAt(++i)
        if (next === 0x9c || (code === 0x9d && next === 7)) break
        if (next === 0x1b && text[i + 1] === '\\') {
          i++
          break
        }
      }
    } else if (code < 0x80 || code > 0x9f) out += text[i] ?? ''
  }
  return out
}

function inline(tokens: Token[], ansi: ThemedAnsi, style: Style = PLAIN): Span[] {
  return tokens.flatMap((token): Span[] => {
    if (token.type === 'strong')
      return inline((token as Tokens.Strong).tokens, ansi, { ...style, bold: true })
    if (token.type === 'em') return inline((token as Tokens.Em).tokens, ansi, { ...style, italic: true })
    if (token.type === 'codespan') {
      const text = (token as Tokens.Codespan).text
      // No-break padding stays attached to the code when a line wraps.
      return [span(shades(ansi) ? ` ${text} ` : text, { ...style, code: true })]
    }
    if (token.type === 'link') {
      const link = token as Tokens.Link
      const label = inline(link.tokens, ansi, { ...style, link: true })
      return link.href === plain(label)
        ? label
        : [...label, span(` (${link.href})`, { ...style, tone: 'faint' })]
    }
    if (token.type === 'math') {
      const { raw, text } = token as Tokens.Generic
      const math = ansi.raw ? undefined : renderLatex(String(text), { display: false })
      return [math === undefined ? span(String(raw), style) : span(math, { ...style, tone: 'accent' })]
    }
    if (token.type === 'del') return inline((token as Tokens.Del).tokens, ansi, style)
    if (token.type === 'br') return [span('\n', style)]
    if (token.type === 'text' && token.tokens) return inline(token.tokens, ansi, style)
    return 'text' in token ? [span(String(token.text), style)] : []
  })
}

function draw(text: string, style: Style, ansi: ThemedAnsi): string {
  let out = text
  if (style.code) out = ansi.bg('codeBg', ansi.fg('code', out))
  else if (style.link) out = ansi.underline(ansi.fg('link', out))
  else if (style.tone) out = ansi.fg(style.tone, out)
  if (style.italic) out = ansi.italic(out)
  return style.bold ? ansi.bold(out) : out
}

function paint(units: Span[], ansi: ThemedAnsi): string {
  const out: string[] = []
  let text = ''
  let style = PLAIN
  const flush = () => {
    if (text) out.push(draw(text, style, ansi))
    text = ''
  }
  for (const unit of units) {
    if (unit.style !== style) {
      flush()
      style = unit.style
    }
    text += unit.text
  }
  flush()
  return out.join('')
}

/** Wrap before styling so every line has balanced SGR and words can span emphasis boundaries. */
function wrap(spans: Span[], width: number, ansi: ThemedAnsi): string[] {
  const out: string[] = []
  let line: Span[] = []
  let gap: Span[] = []
  let word: Span[] = []
  const emit = () => {
    out.push(paint(line, ansi))
    line = []
  }
  const flush = () => {
    if (!word.length) return
    if (line.length && displayWidth(plain([...line, ...gap, ...word])) > width) emit()
    if (line.length) line.push(...gap)
    gap = []
    for (const unit of word) {
      const part = displayWidth(unit.text) > width ? span('…', unit.style) : unit
      if (line.length && displayWidth(plain([...line, part])) > width) emit()
      line.push(part)
    }
    word = []
  }
  for (const part of spans)
    for (const { segment } of graphemes.segment(part.text)) {
      if (segment === '\n') {
        flush()
        emit()
        gap = []
      } else if (segment === ' ') {
        flush()
        gap.push(span(segment, part.style))
      } else word.push(span(segment, part.style))
    }
  flush()
  if (line.length || out.length === 0) emit()
  return out
}

function clip(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  let out = ''
  for (const { segment } of graphemes.segment(text)) {
    if (displayWidth(out + segment) > width - 1) break
    out += segment
  }
  return `${out}…`
}

function table(token: Tokens.Table, width: number, ansi: ThemedAnsi, base: Style): string[] {
  const header = { ...base, bold: true } as const
  const cells = [token.header, ...token.rows].map((row, y) =>
    row.map((cell) => inline(cell.tokens, ansi, y === 0 ? header : base)),
  )
  const count = token.header.length
  if (!count) return []
  const desired = Array<number>(count).fill(1)
  for (const row of cells)
    row.forEach((cell, i) => {
      desired[i] = Math.max(desired[i] ?? 1, displayWidth(plain(cell)))
    })
  const available = width - (3 * count + 1)
  if (available < count) {
    // A horizontal table cannot fit even one column per cell; retain every labelled value vertically.
    if (cells.length === 1) return (cells[0] ?? []).flatMap((cell) => wrap(cell, width, ansi))
    return cells
      .slice(1)
      .flatMap((row) =>
        row.flatMap((cell, i) =>
          wrap([span(`${plain(cells[0]?.[i] ?? [])}: `, header), ...cell], width, ansi),
        ),
      )
  }
  const widths = Array<number>(count).fill(1)
  let remaining = available - count
  while (remaining > 0) {
    let changed = false
    for (let i = 0; i < count && remaining > 0; i++)
      if ((widths[i] ?? 0) < (desired[i] ?? 0)) {
        widths[i] = (widths[i] ?? 0) + 1
        remaining--
        changed = true
      }
    if (!changed) break
  }
  const bar = ansi.fg('border', '│')
  const rule = ansi.fg('border', `├${widths.map((size) => '─'.repeat(size + 2)).join('┼')}┤`)
  return cells.flatMap((row, y) => {
    const wrapped = row.map((cell, i) => wrap(cell, widths[i] ?? 1, ansi))
    const height = wrapped.reduce((max, lines) => Math.max(max, lines.length), 1)
    const lines = Array.from(
      { length: height },
      (_, line) =>
        `${bar} ${widths.map((size, x) => pad(wrapped[x]?.[line] ?? '', size)).join(` ${bar} `)} ${bar}`,
    )
    return y === 0 ? [...lines, rule] : lines
  })
}

/** One code line in the block colour, its runs in their own tones; `body` is the clipped, padded line. */
function paintCode(body: string, runs: CodeRun[] | undefined, ansi: ThemedAnsi): string {
  const out: CodeRun[] = []
  let pos = 0
  const add = (text: string, tone?: Tone) => {
    if (text === '') return
    const last = out.at(-1)
    if (last && last.tone === tone) last.text += text
    else out.push(tone ? { text, tone } : { text })
  }
  // The two columns of indent come first; what clipping or padding added after the runs is plain.
  for (const run of [{ text: '  ' }, ...(runs ?? [])] as CodeRun[]) {
    add(body.slice(pos, pos + run.text.length), run.tone)
    pos += run.text.length
  }
  add(body.slice(pos))
  return out.map((run) => ansi.fg(run.tone ?? 'surfaceFg', run.text)).join('')
}

/** Cuts a line into rows of at most `width` columns without losing a character. */
function hardWrap(line: string, width: number): string[] {
  const rows: string[] = ['']
  for (const { segment } of graphemes.segment(line)) {
    const last = rows.length - 1
    if (rows[last] !== '' && displayWidth(rows[last] + segment) > width) rows.push(segment)
    else rows[last] += segment
  }
  return rows
}

/** A formula as Unicode lines in the accent tone, indented; undefined when it has to stay source. */
function mathBlock(src: string, width: number, ansi: ThemedAnsi): string[] | undefined {
  const math = ansi.raw ? undefined : renderLatex(src, { display: true })
  return math
    ?.split('\n')
    .flatMap((line) => hardWrap(`  ${line}`, width).map((row) => ansi.fg('accent', row)))
}

function code(token: Tokens.Code, width: number, ansi: ThemedAnsi): string[] {
  const lang = token.lang?.trim().split(/\s/)[0] ?? ''
  const math = MATH_FENCES.has(lang) ? mathBlock(token.text, width, ansi) : undefined
  if (math) return math
  const diagram =
    lang === 'mermaid' && !ansi.raw && fenceClosed(token.raw)
      ? mermaidBlock(token.text, width, ansi)
      : undefined
  if (diagram) return diagram
  // Raw view: the language on a line of its own, then the code as it is, so a copy is the code itself.
  if (ansi.raw)
    return [
      ...(lang ? [ansi.dim(lang)] : []),
      ...token.text.split('\n').flatMap((line) => hardWrap(line, width)),
    ]
  const label = lang && width - displayWidth(lang) >= 10 ? ` ${lang} ` : ''
  const shaded = shades(ansi)
  const runs = shaded ? highlight(token.text, lang) : undefined
  return token.text.split('\n').map((line, i) => {
    const tag = i === 0 ? label : ' '.repeat(displayWidth(label))
    const clipped = clip(`  ${line}`, width - displayWidth(tag))
    const body = shaded || label ? pad(clipped, width - displayWidth(tag)) : clipped
    const text = shaded ? paintCode(body, runs?.[i], ansi) : ansi.dim(body)
    return ansi.bg('surface', text + ansi.fg('faint', tag))
  })
}

function blocks(tokens: Token[], width: number, ansi: ThemedAnsi, base: Style = PLAIN): string[] {
  const out: string[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        if (out.length && out.at(-1) !== '') out.push('')
        break
      case 'heading': {
        const heading = token as Tokens.Heading
        const style = { ...base, ...(HEADING[heading.depth] ?? { bold: true, tone: 'muted' }) }
        out.push(...wrap(inline(heading.tokens, ansi, style), width, ansi))
        break
      }
      case 'paragraph':
      case 'text': {
        const text = token as Tokens.Text
        const formula = displayMathSource(text.raw)
        if (formula !== undefined && !ansi.raw) {
          out.push(
            ...(mathBlock(formula, width, ansi) ??
              code({ type: 'code', raw: formula, text: formula }, width, ansi)),
          )
          break
        }
        out.push(...wrap(inline(text.tokens ?? Lexer.lexInline(text.text), ansi, base), width, ansi))
        break
      }
      case 'code':
        out.push(...code(token as Tokens.Code, width, ansi))
        break
      case 'list': {
        const list = token as Tokens.List
        list.items.forEach((item, index) => {
          const start = typeof list.start === 'number' ? list.start : 1
          const mark = item.task ? (item.checked ? ' [x]' : ' [ ]') : ''
          const bullet = (list.ordered ? `${start + index}.` : '•') + mark
          const fits = width > displayWidth(bullet) + 1
          const indent = fits ? displayWidth(bullet) + 1 : 0
          const prefix = fits ? `${ansi.fg(list.ordered ? 'muted' : 'accentSoft', bullet)} ` : ''
          const content = blocks(item.tokens, Math.max(1, width - indent), ansi, base)
          out.push(...content.map((line, i) => (i === 0 ? prefix : ' '.repeat(indent)) + line))
        })
        break
      }
      case 'table':
        out.push(...table(token as Tokens.Table, width, ansi, base))
        break
      case 'blockquote': {
        const prefix = width > 2 && !ansi.raw ? `${ansi.fg('accentSoft', '▎')} ` : ''
        const quote = { ...base, italic: true, tone: 'muted' } as const
        out.push(
          ...blocks(
            (token as Tokens.Blockquote).tokens,
            Math.max(1, width - (prefix ? 2 : 0)),
            ansi,
            quote,
          ).map((line) => prefix + line),
        )
        break
      }
      case 'html':
        out.push(...wrap(inline(Lexer.lexInline((token as Tokens.HTML).text), ansi, base), width, ansi))
        break
      case 'hr':
        out.push(ansi.fg('border', '─'.repeat(width)))
        break
      case 'def':
        break
      default:
        if ('text' in token) out.push(...wrap([span(String(token.text), base)], width, ansi))
    }
  }
  while (out.at(-1) === '') out.pop()
  return out
}

/**
 * How many leading characters of a still-growing Markdown text are made of blocks that are finished:
 * every block that has another one after it. The last block may still take more text (a paragraph, a
 * list item, an unclosed code fence), so it is not counted. 0 when the lexer's blocks do not add back
 * up to the text, which is when nothing can be told apart safely.
 */
export function completeBlocks(text: string): number {
  const tokens = Lexer.lex(text, { gfm: true })
  if (tokens.map((token) => token.raw).join('') !== text) return 0
  let offset = 0
  let lastStart = 0
  for (const token of tokens) {
    if (token.type !== 'space') lastStart = offset
    offset += token.raw.length
  }
  return lastStart
}

/** Terminal-only Markdown: HTML is literal text; links/images never trigger I/O. */
export function renderMarkdown(md: string, width: number, ansi: ThemedAnsi): string[] {
  if (!Number.isFinite(width)) throw new Error('invalid markdown width')
  const clean = stripVT(md).replace(CONTROL, '').replaceAll('\t', '    ')
  return blocks(Lexer.lex(clean, mathLexerOptions()), Math.max(1, Math.trunc(width)), ansi)
}

/** A leading part of a longer text: the blank line that separates it from what follows is kept. */
export function renderMarkdownChunk(md: string, width: number, ansi: ThemedAnsi): string[] {
  const rows = renderMarkdown(md, width, ansi)
  return rows.length > 0 && /\n[ \t]*\n\s*$/.test(md) ? [...rows, ''] : rows
}
