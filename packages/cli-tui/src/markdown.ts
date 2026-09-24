import { Lexer, type Token, type Tokens } from 'marked'
import type { Ansi } from './ansi.js'
import { displayWidth } from './terminal.js'

type Span = { text: string; bold: boolean }
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// VT sequences are removed first, including their parameters; these are remaining control bytes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: remove untrusted terminal controls
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
const span = (text: string, bold = false): Span => ({ text, bold })
const plain = (spans: Span[]) => spans.map((part) => part.text).join('')

/** Consume terminal commands without allowing an OSC terminator to swallow preceding CSI text. */
function stripVT(text: string): string {
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

function inline(tokens: Token[], bold = false): Span[] {
  return tokens.flatMap((token): Span[] => {
    if (token.type === 'strong' || token.type === 'em') return inline((token as Tokens.Strong).tokens, true)
    if (token.type === 'link' || token.type === 'del') return inline((token as Tokens.Link).tokens, bold)
    if (token.type === 'br') return [span('\n', bold)]
    if (token.type === 'text' && token.tokens) return inline(token.tokens, bold)
    return 'text' in token ? [span(String(token.text), bold)] : []
  })
}

function paint(units: Span[], ansi: Ansi): string {
  const out: string[] = []
  let text = ''
  let bold = false
  const flush = () => {
    if (text) out.push(bold ? ansi.bold(text) : text)
    text = ''
  }
  for (const unit of units) {
    if (unit.bold !== bold) {
      flush()
      bold = unit.bold
    }
    text += unit.text
  }
  flush()
  return out.join('')
}

/** Wrap before styling so every line has balanced SGR and words can span emphasis boundaries. */
function wrap(spans: Span[], width: number, ansi: Ansi): string[] {
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
      const part = displayWidth(unit.text) > width ? span('…', unit.bold) : unit
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
        gap.push(span(segment, part.bold))
      } else word.push(span(segment, part.bold))
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

function table(token: Tokens.Table, width: number, ansi: Ansi): string[] {
  const cells = [token.header, ...token.rows].map((row) => row.map((cell) => inline(cell.tokens)))
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
        row.flatMap((cell, i) => wrap([span(`${plain(cells[0]?.[i] ?? [])}: `), ...cell], width, ansi)),
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
  return cells.flatMap((row) => {
    const wrapped = row.map((cell, i) => wrap(cell, widths[i] ?? 1, ansi))
    const height = wrapped.reduce((max, lines) => Math.max(max, lines.length), 1)
    return Array.from(
      { length: height },
      (_, y) =>
        `│ ${widths
          .map((size, x) => {
            const text = wrapped[x]?.[y] ?? ''
            return text + ' '.repeat(Math.max(0, size - displayWidth(text)))
          })
          .join(' │ ')} │`,
    )
  })
}

function blocks(tokens: Token[], width: number, ansi: Ansi): string[] {
  const out: string[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        if (out.length && out.at(-1) !== '') out.push('')
        break
      case 'heading':
        out.push(...wrap(inline((token as Tokens.Heading).tokens, true), width, ansi))
        break
      case 'paragraph':
      case 'text': {
        const text = token as Tokens.Text
        out.push(...wrap(inline(text.tokens ?? Lexer.lexInline(text.text)), width, ansi))
        break
      }
      case 'code':
        out.push(...(token as Tokens.Code).text.split('\n').map((line) => ansi.dim(clip(`  ${line}`, width))))
        break
      case 'list': {
        const list = token as Tokens.List
        list.items.forEach((item, index) => {
          const start = typeof list.start === 'number' ? list.start : 1
          const bullet = list.ordered ? `${start + index}. ` : '• '
          const prefix = width > displayWidth(bullet) ? bullet : ''
          const content = blocks(item.tokens, Math.max(1, width - displayWidth(prefix)), ansi)
          out.push(...content.map((line, i) => (i === 0 ? prefix : ' '.repeat(displayWidth(prefix))) + line))
        })
        break
      }
      case 'table':
        out.push(...table(token as Tokens.Table, width, ansi))
        break
      case 'blockquote': {
        const prefix = width > 2 ? '> ' : ''
        out.push(
          ...blocks((token as Tokens.Blockquote).tokens, Math.max(1, width - prefix.length), ansi).map(
            (line) => prefix + line,
          ),
        )
        break
      }
      case 'html':
        out.push(...wrap(inline(Lexer.lexInline((token as Tokens.HTML).text)), width, ansi))
        break
      case 'hr':
        out.push('─'.repeat(width))
        break
      case 'def':
        break
      default:
        if ('text' in token) out.push(...wrap([span(String(token.text))], width, ansi))
    }
  }
  while (out.at(-1) === '') out.pop()
  return out
}

/** Terminal-only Markdown: HTML is literal text; links/images never trigger I/O. */
export function renderMarkdown(md: string, width: number, ansi: Ansi): string[] {
  if (!Number.isFinite(width)) throw new Error('invalid markdown width')
  const clean = stripVT(md).replace(CONTROL, '').replaceAll('\t', '    ')
  return blocks(Lexer.lex(clean, { gfm: true }), Math.max(1, Math.trunc(width)), ansi)
}
