import type { Tone } from './palette.js'

/** A run of code text and the tone it is drawn in; `undefined` is the block's own colour. */
export type CodeRun = { text: string; tone?: Tone }

// A block longer than this is drawn in one colour: scanning it is not what the reader came for.
export const MAX_HIGHLIGHT_LINES = 2000
// Minified code or a base64 blob is one enormous line; past this many characters nothing is scanned.
export const MAX_HIGHLIGHT_CHARS = 200_000

const HASH = new Set([
  'py',
  'python',
  'sh',
  'bash',
  'zsh',
  'shell',
  'yaml',
  'yml',
  'toml',
  'rb',
  'ruby',
  'r',
  'perl',
  'make',
  'dockerfile',
  'ini',
])
const DASH = new Set(['sql', 'lua', 'hs', 'haskell'])
const KEYWORDS =
  'if|else|elif|for|while|do|return|function|func|fn|def|const|let|var|class|struct|enum|interface|type|trait|impl|mod|import|export|from|use|package|new|true|false|null|nil|undefined|None|True|False|async|await|try|catch|except|finally|throw|raise|switch|case|break|continue|in|of|is|not|and|or|match|self|this|static|public|private|protected|void|int|string|bool'

// A quoted string is bounded (an unmatched quote rescans at most 500 characters); the open-ended
// patterns run to the end of the text when unterminated, so the scan always moves on.
// Order is priority: a comment or string hides what looks like a number or keyword inside it. Every
// pattern stops at the end of its line except a block comment and a triple-quoted string.
const scanner = (lang: string): RegExp => {
  const comment = HASH.has(lang)
    ? '#[^\\n]*'
    : DASH.has(lang)
      ? '--[^\\n]*'
      : '//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)'
  const string =
    '"""[\\s\\S]*?(?:"""|$)|"(?:\\\\.|[^"\\\\\\n]){0,500}"|\'(?:\\\\.|[^\'\\\\\\n]){0,500}\'|`(?:\\\\.|[^`\\\\])*(?:`|$)'
  return new RegExp(
    `(?<comment>${comment})|(?<string>${string})|(?<number>\\b(?:0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)|(?<keyword>\\b(?:${KEYWORDS})\\b)`,
    'g',
  )
}
const TONE: Record<string, Tone> = {
  comment: 'faint',
  string: 'success',
  number: 'warning',
  keyword: 'accent',
}

/**
 * Code split into runs per line, by what each run is: comment, string, number or keyword. Any
 * language gets the same small set of rules (the label only picks the comment marker), so an unknown
 * one is still coloured. The runs of a line concatenate to exactly that line.
 */
export function highlight(code: string, lang: string): CodeRun[][] | undefined {
  if (code.length > MAX_HIGHLIGHT_CHARS) return undefined
  const text = code.replaceAll('\r', '')
  if (text.split('\n').length > MAX_HIGHLIGHT_LINES) return undefined
  const lines: CodeRun[][] = [[]]
  const push = (part: string, tone?: Tone) => {
    part.split('\n').forEach((piece, i) => {
      if (i > 0) lines.push([])
      if (piece !== '') (lines.at(-1) as CodeRun[]).push(tone ? { text: piece, tone } : { text: piece })
    })
  }
  let at = 0
  for (const m of text.matchAll(scanner(lang.toLowerCase()))) {
    push(text.slice(at, m.index))
    const kind = Object.entries(m.groups ?? {}).find(([, v]) => v !== undefined)?.[0] ?? ''
    push(m[0], TONE[kind])
    at = m.index + m[0].length
  }
  push(text.slice(at))
  return lines
}
