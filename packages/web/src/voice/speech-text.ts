import { VOICE_SPEAK_MAX_CHARS } from '@agnes/protocol'

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const TABLE_CELL = /^\s*:?-+:?\s*$/
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S+/
const URL_BODY = String.raw`[^\s<>　-〿一-鿿＀-￯]*[^\s<>.,;:!?'")\]　-〿一-鿿＀-￯]`

function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|') && !trimmed.includes(':')) return false
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.every((cell) => TABLE_CELL.test(cell))
}

/** Drops fenced code, tables, rules and link definitions; returns the remaining lines. */
function proseLines(markdown: string): string[] {
  const kept: string[] = []
  let fence: { char: string; size: number } | undefined
  let inTable = false
  for (const line of markdown.split(/\r?\n/)) {
    const opening = FENCE.exec(line)
    if (fence) {
      const closing = opening?.[1]
      if (
        closing &&
        closing[0] === fence.char &&
        closing.length >= fence.size &&
        !line.trim().slice(closing.length)
      ) {
        fence = undefined
      }
      continue
    }
    if (opening) {
      const marker = opening[1] ?? ''
      fence = { char: marker.charAt(0), size: marker.length }
      continue
    }
    if (isSeparatorRow(line)) {
      if (line.includes('|') && kept.at(-1)?.includes('|')) kept.pop()
      inTable = line.includes('|')
      continue
    }
    if (line.trimStart().startsWith('|') || (inTable && line.includes('|'))) continue
    inTable = false
    if (RULE.test(line) || LINK_DEFINITION.test(line)) continue
    kept.push(line)
  }
  return kept
}

function stripInline(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:https?:\/\/|www\.|mailto:)[^<>\s]*>/g, ' ')
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, ' ')
    .replace(/!\[[^\]]*\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/g, '')
    .replace(/\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(new RegExp(String.raw`(?:https?:\/\/|www\.)${URL_BODY}`, 'g'), '')
    .replace(/(`+)([^`]*?)\1/g, '$2')
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, '$1')
}

/** Reads a markdown answer as plain speech: no code, tables, URLs or markup marks, one line of text. */
export function speechText(markdown: string): string {
  const lines = proseLines(markdown).map((line) =>
    line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^(?:\s{0,3}>)+\s?/, '')
      .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, ''),
  )
  return stripInline(lines.join('\n')).replace(/\s+/g, ' ').trim()
}

const TERMINATORS = new Set('。！？!?；;…')
const CLOSERS = new Set('”’"\')）」』】》')
const SOFT_BREAKS = new Set('，,、：:')

/** Sentences with their leading whitespace kept, so packing them back together loses nothing. */
function sentences(text: string): string[] {
  const out: string[] = []
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i)
    current += char
    if (TERMINATORS.has(char)) {
      while (
        i + 1 < text.length &&
        (TERMINATORS.has(text.charAt(i + 1)) || CLOSERS.has(text.charAt(i + 1)))
      ) {
        current += text.charAt(++i)
      }
    } else if (char !== '.' || !/\s/.test(text.charAt(i + 1))) {
      continue
    }
    out.push(current)
    current = ''
  }
  if (current) out.push(current)
  return out
}

function splitAfter(text: string, breaks: ReadonlySet<string>): string[] {
  const out: string[] = []
  let current = ''
  for (const char of text) {
    current += char
    if (breaks.has(char)) {
      out.push(current)
      current = ''
    }
  }
  if (current) out.push(current)
  return out
}

/** Cuts every `max` UTF-16 units, backing off one unit rather than splitting a surrogate pair. */
function hardCut(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = max
    const last = rest.charCodeAt(cut - 1)
    if (last >= 0xd800 && last <= 0xdbff && cut > 1) cut--
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

/** Pieces of at most `max` units: the sentence itself, else its clauses, else hard cuts. */
function units(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence]
  return splitAfter(sentence, SOFT_BREAKS).flatMap((clause) =>
    clause.length <= max ? [clause] : hardCut(clause, max),
  )
}

/**
 * Splits speech into TTS requests of at most `max` UTF-16 code units (the server cap): sentences are packed
 * greedily, an over-long one splits at commas and then hard-cuts. Segments are trimmed and never empty.
 */
export function speechSegments(text: string, max: number = VOICE_SPEAK_MAX_CHARS): string[] {
  const out: string[] = []
  let current = ''
  const flush = () => {
    const segment = current.trim()
    if (segment) out.push(segment)
    current = ''
  }
  for (const piece of sentences(text).flatMap((sentence) => units(sentence, max))) {
    if (current && (current + piece).trimEnd().length > max) flush()
    current += current ? piece : piece.trimStart()
  }
  flush()
  return out
}
