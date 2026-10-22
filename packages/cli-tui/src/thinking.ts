import type { UINode } from '@agnes/protocol'
import { type Component, escapeControl, wrapText } from './component.js'
import { fitLine } from './components/line.js'
import { tt } from './locale-extended.js'
import { renderMarkdown } from './markdown.js'
import { nodeText } from './node-text.js'
import type { ThemedAnsi } from './theme.js'

// While the model is still thinking the reply area shows the tail of its thoughts, this many screen rows.
const STREAMING_ROWS = 3
// With `/thinking` open, thoughts stay on screen; this many of the latest rows, so a long chain stays bounded.
const EXPANDED_ROWS = 40

/** `/thinking`: whether thoughts stay open after the answer starts. Per process, never stored. */
export const thinkingMode = {
  expanded: false,
  toggle(): boolean {
    this.expanded = !this.expanded
    return this.expanded
  },
}

/**
 * The rows thoughts take above a reply: the tail of them while the model has not started answering,
 * otherwise one line saying how much it thought (all of it, tailed, when `/thinking` has them open).
 * Thoughts are model output: escaped, and painted quiet.
 */
export function thinkingRows(
  thinking: string | undefined,
  o: { answering: boolean; width: number; ansi: ThemedAnsi; locale: string },
): string[] {
  if (!thinking?.trim()) return []
  const tail = (rows: number) =>
    wrapText(escapeControl(thinking.trim()), Math.max(1, o.width - 2))
      .filter((row) => row.trim() !== '')
      .slice(-rows)
      .map((row) => fitLine(o.ansi.fg('thinking', `  ${row}`), o.width))
  if (thinkingMode.expanded) return tail(EXPANDED_ROWS)
  if (!o.answering) return tail(STREAMING_ROWS)
  const chars = [...thinking].length
  return [fitLine(o.ansi.fg('thinking', `✻ ${tt('thinking.done', o.locale, { n: chars })}`), o.width)]
}

/** A finished reply: its folded thoughts, then the Markdown. */
export function assistantView(
  node: Extract<UINode, { kind: 'assistant' }>,
  ansi: ThemedAnsi,
  locale: string,
): Component {
  return {
    render: (width) => [
      '',
      ...thinkingRows(node.thinking, { answering: true, width, ansi, locale }),
      ...renderMarkdown(nodeText(node), width, ansi),
    ],
    transcript: (width) => renderMarkdown(nodeText(node), width, ansi),
    transcriptAfter: (prefix, width) => {
      const text = nodeText(node)
      let same = 0
      while (same < prefix.length && text[same] === prefix[same]) same++
      return renderMarkdown(text.slice(same), width, ansi)
    },
    invalidate() {},
  }
}

/** What the streaming inferences have said so far, drawn under the conversation. */
export class LiveView implements Component {
  private streams: () => Array<{ text: string; thinking: string }> = () => []

  constructor(
    private readonly ansi: ThemedAnsi,
    private readonly locale: string,
  ) {}

  /** The streams to draw: a list, or a function read at every draw for text that is still being written out. */
  set(
    streams: Array<{ text: string; thinking: string }> | (() => Array<{ text: string; thinking: string }>),
  ): void {
    this.streams = typeof streams === 'function' ? streams : () => streams
  }

  invalidate(): void {}

  render(width: number): string[] {
    const streams = this.streams()
    const text = streams.map((s) => s.text).join('')
    const thinking = streams.map((s) => s.thinking).join('')
    const rows = thinkingRows(thinking, {
      answering: text !== '',
      width,
      ansi: this.ansi,
      locale: this.locale,
    })
    return [...rows, ...(text === '' && rows.length > 0 ? [] : wrapText(escapeControl(text), width))]
  }
}
