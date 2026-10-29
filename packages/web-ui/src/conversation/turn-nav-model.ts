import type { UINode, UITurn } from '@agnes/protocol'
import { isSystemInput } from './messages/message.js'
import { userMessageText } from './messages/user-message.js'

/** What the preview card says about the answer to one prompt. */
export type TurnNavReply =
  | { kind: 'text'; lead: string; more?: string }
  | { kind: 'streaming' }
  | { kind: 'tools'; count: number }
  | { kind: 'status'; status: UITurn['status'] }
  | { kind: 'none' }

/** One tick of the rail: one thing the reader asked. */
export type TurnNavEntry = {
  /** The prompt's user message id: stable across reloads, and what a session's bookmarks hold. */
  id: string
  /** The element the transcript renders for it carries this attribute and value. */
  anchor: { attribute: 'data-turn-id' | 'data-node-id'; value: string }
  /** The turn's number in the session (stays right when earlier history is not loaded). */
  number: number
  prompt: string
  startedAt?: string
  reply: TurnNavReply
}

export const TICK = {
  /** Resting length for every tick; the current turn only lengthens while the rail is hovered. */
  idle: 12,
  current: 22,
  /** Longest length under the pointer, reached at distance 0 and gone by `reach` pixels. */
  max: 30,
  reach: 40,
  /** Stroke thickness and the comfortable gap between strokes. */
  line: 2,
  gap: 7,
  minGap: 3,
  /** Above this many prompts the gap shrinks so the rail stays within `maxHeight` of the pane. */
  denseFrom: 40,
  maxHeight: 0.6,
} as const

/** The rail needs a window this wide and this much empty space left of the messages. */
export const RAIL_MIN_VIEWPORT = 900
export const RAIL_MIN_GUTTER = 56

const ACTIVE: ReadonlySet<UITurn['status']> = new Set(['running', 'waiting'])

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Plain reading text of a Markdown paragraph: markers, emphasis and link targets dropped. */
function plain(paragraph: string): string {
  return oneLine(
    paragraph
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2'),
  )
}

/** The first paragraph of an answer and the one after it, as the card shows them. */
export function replyParagraphs(text: string): { lead: string; more?: string } | undefined {
  const paragraphs = text
    .replace(/```[^\n]*\n?/g, '')
    .split(/\n\s*\n/)
    .map(plain)
    .filter(Boolean)
  const [lead, more] = paragraphs
  if (!lead) return undefined
  return more ? { lead, more } : { lead }
}

function replyOf(members: readonly UINode[], status: UITurn['status'] | undefined, finalId?: string) {
  const answers = members.filter(
    (node): node is Extract<UINode, { kind: 'assistant' }> => node.kind === 'assistant',
  )
  const final = answers.find((node) => node.id === finalId && node.text.trim())
  const written = final ?? answers.findLast((node) => node.text.trim())
  if (status && ACTIVE.has(status)) return { kind: 'streaming' } as const
  const text = written && replyParagraphs(written.text)
  if (text) return { kind: 'text', ...text } as const
  const tools = members.filter((node) => node.kind === 'tool').length
  if (tools > 0) return { kind: 'tools', count: tools } as const
  if (status && status !== 'completed') return { kind: 'status', status } as const
  return { kind: 'none' } as const
}

const isPrompt = (node: UINode | undefined): node is Extract<UINode, { kind: 'user' }> =>
  node?.kind === 'user' && !isSystemInput(node)

/**
 * One entry per prompt the reader wrote, in transcript order. A turn that a system input started
 * (a schedule, a resumed job) has no prompt of the reader's and no tick.
 */
export function turnNavEntries(nodes: readonly UINode[], turns?: readonly UITurn[]): TurnNavEntry[] {
  const byId = new Map(nodes.map((node) => [node.id, node] as const))
  if (turns?.length)
    return turns.flatMap((turn) => {
      const members = turn.nodeIds.flatMap((id) => {
        const node = byId.get(id)
        return node ? [node] : []
      })
      const prompt = members.find(isPrompt)
      if (!prompt) return []
      return [
        {
          id: prompt.id,
          anchor: { attribute: 'data-turn-id', value: turn.id },
          number: turn.turn,
          prompt: oneLine(userMessageText(prompt)),
          startedAt: turn.startedAt,
          reply: replyOf(members, turn.status, turn.finalAssistantId),
        } satisfies TurnNavEntry,
      ]
    })
  // A transcript without turns: each prompt owns what follows it until the next prompt.
  const entries: TurnNavEntry[] = []
  let members: UINode[] = []
  let prompt: Extract<UINode, { kind: 'user' }> | undefined
  const close = () => {
    if (!prompt) return
    const streaming = members.some((node) => node.kind === 'assistant' && node.streaming === true)
    entries.push({
      id: prompt.id,
      anchor: { attribute: 'data-node-id', value: prompt.id },
      number: entries.length + 1,
      prompt: oneLine(userMessageText(prompt)),
      reply: replyOf(members, streaming ? 'running' : undefined),
    })
  }
  for (const node of nodes) {
    if (isPrompt(node)) {
      close()
      prompt = node
      members = []
    } else members.push(node)
  }
  close()
  return entries
}

/** Tick length for a pointer `distance` pixels away (undefined: no pointer over the rail). */
export function tickWidth(distance: number | undefined, current: boolean, reducedMotion: boolean): number {
  if (distance === undefined || reducedMotion) return TICK.idle
  const near = TICK.idle + Math.max(0, (TICK.max - TICK.idle) * (1 - Math.abs(distance) / TICK.reach))
  const width = Math.round(near * 10) / 10
  return current ? Math.max(width, TICK.current) : width
}

/** Gap between ticks: comfortable up to 40 prompts, then tighter, never taller than 60% of the pane. */
export function tickGap(count: number, paneHeight: number): number {
  if (count <= TICK.denseFrom) return TICK.gap
  const byCount = TICK.gap - ((count - TICK.denseFrom) / TICK.denseFrom) * (TICK.gap - TICK.minGap)
  const fit = paneHeight > 0 ? (paneHeight * TICK.maxHeight - count * TICK.line) / (count - 1) : TICK.gap
  return Math.max(TICK.minGap, Math.min(TICK.gap, byCount, fit))
}

/** Index of the tick nearest a pointer at `y`, measured from the centre of the first tick. */
export function nearestTick(y: number, pitch: number, count: number): number {
  if (count === 0) return -1
  return Math.max(0, Math.min(count - 1, Math.round(y / pitch)))
}

/**
 * The turn being read: the last one whose top has reached the upper 45% of the viewport.
 * `tops` are measured from the viewport's top edge.
 */
export function currentTurn(tops: readonly number[], viewportHeight: number): number {
  let current = 0
  tops.forEach((top, index) => {
    if (top < viewportHeight * 0.45) current = index
  })
  return current
}

export function railHidden(input: { count: number; viewportWidth: number; gutter: number }): boolean {
  return input.count < 2 || input.viewportWidth < RAIL_MIN_VIEWPORT || input.gutter < RAIL_MIN_GUTTER
}

/** Add or remove one bookmark, keeping the order they were added in. */
export function toggleBookmark(bookmarks: readonly string[], id: string): string[] {
  return bookmarks.includes(id) ? bookmarks.filter((value) => value !== id) : [...bookmarks, id]
}
