// Adapted from oh-my-pi; see LICENSE.oh-my-pi.
/** Enough prefix/suffix for any final 2000-character 2:1 split, including scaffolding. */
export const TITLE_HEAD = 1334
export const TITLE_TAIL = 667
export type TitleSection = { head: string; tail: string; length: number }
export const section = (text: string): TitleSection => ({
  head: text.slice(0, TITLE_HEAD),
  tail: text.slice(-TITLE_TAIL),
  length: text.length,
})
export type TitleTurn = {
  seq: number
  role: 'user' | 'assistant'
  text: TitleSection
  thinking: TitleSection
}
type Part = string | TitleSection
const lengthOf = (part: Part) => part.length
function prefix(parts: Part[], count: number): string {
  let out = ''
  for (const part of parts) {
    const size = Math.min(count - out.length, lengthOf(part))
    out +=
      typeof part === 'string'
        ? part.slice(0, size)
        : size <= part.head.length
          ? part.head.slice(0, size)
          : part.head +
            part.tail.slice(
              part.tail.length - (part.length - part.head.length),
              part.tail.length - (part.length - size),
            )
    if (out.length >= count) break
  }
  return out
}
function suffix(parts: Part[], count: number): string {
  let out = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part === undefined) continue
    const size = Math.min(count - out.length, lengthOf(part))
    out =
      (typeof part === 'string'
        ? part.slice(-size || part.length)
        : part.tail.slice(-size || part.tail.length)) + out
    if (out.length >= count) break
  }
  return out
}
export function formatTitleContext(turns: TitleTurn[]): string {
  const parts: Part[] = []
  for (const turn of turns) {
    if (!turn.text.length && !turn.thinking.length) continue
    if (parts.length) parts.push('\n\n')
    parts.push(`<${turn.role}>\n`)
    if (turn.text.length) parts.push(turn.text)
    if (turn.thinking.length) {
      if (turn.text.length) parts.push('\n\n')
      parts.push('<think>\n', turn.thinking, '\n</think>')
    }
    parts.push(`\n</${turn.role}>`)
  }
  if (!parts.length) return ''
  parts.unshift('<chat>\n')
  parts.push('\n</chat>')
  const length = parts.reduce((sum, part) => sum + lengthOf(part), 0)
  if (length <= 2000) return prefix(parts, length)
  let omitted = length - 2000,
    marker = '',
    head = 0,
    tail = 0
  for (let pass = 0; pass < 2; pass++) {
    marker = `\n[… ${omitted} chars omitted …]\n`
    const kept = Math.max(0, 2000 - marker.length)
    head = Math.ceil((kept * 2) / 3)
    tail = kept - head
    omitted = length - head - tail
  }
  return `${prefix(parts, head)}\n[… ${omitted} chars omitted …]\n${suffix(parts, tail)}`
}
