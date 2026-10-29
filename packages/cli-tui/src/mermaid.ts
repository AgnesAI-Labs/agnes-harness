import { type Cls, type MermaidArt, render } from 'grok-mermaid'
import type { Tone } from './palette.js'
import type { ThemedAnsi } from './theme.js'

const TONES: Record<Cls, Tone | undefined> = {
  border: 'border',
  text: 'fg',
  edge: 'accent',
  edgeLabel: 'muted',
  title: 'faint',
  none: undefined,
}
const CACHE_LIMIT = 32
const cache = new Map<string, MermaidArt | null>()

/** A fence is finished once its last line is a closing fence; while streaming it stays source. */
export function fenceClosed(raw: string): boolean {
  const lines = raw.trimEnd().split('\n')
  return lines.length > 1 && /^ {0,3}(`{3,}|~{3,})\s*$/.test(lines.at(-1) ?? '')
}

/** Layout is the costly part and depends on the source only, so redraws reuse it. */
function layout(src: string): MermaidArt | null {
  if (cache.has(src)) return cache.get(src) ?? null
  let art: MermaidArt | null = null
  try {
    art = render(src)
  } catch {
    // Any failure leaves the source visible as an ordinary code block.
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(src, art)
  return art
}

/** The diagram as box-drawing lines in theme tones; undefined when it has to stay a code block. */
export function mermaidBlock(src: string, width: number, ansi: ThemedAnsi): string[] | undefined {
  const art = layout(src)
  if (!art || art.width > width) return undefined
  return art.styled.map((row) => {
    const spans = [...row]
    while (spans.length && spans.at(-1)?.text.trim() === '') spans.pop()
    return spans
      .map(({ text, cls }) => {
        const tone = TONES[cls]
        return tone ? ansi.fg(tone, text) : text
      })
      .join('')
  })
}
