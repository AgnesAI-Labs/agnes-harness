import type { DecisionSnapshot, EventEnvelope, TurnEndReason } from '@agnes/protocol'

export const RESULT_V = 'agnes-cli-result/v1' as const

export type CliResult = {
  sessionId: string
  reason: TurnEndReason
  exitCode: number
  lastSeq: number
  credits?: unknown
  ticket?: string
  text?: string
}

/** One line, machine-first: the last thing `--mode json` writes, and the only thing it promises. */
export function cliResultLine(o: CliResult): string {
  return `${JSON.stringify({ v: RESULT_V, ...o })}\n`
}

/**
 * The current unanswered decision a parked turn left behind. Read only each handle's latest
 * state so an answered, consumed or invalidated request cannot revive its earlier open state.
 * Budget and uncertain-effect gates still publish their own pending domain tickets.
 */
export function findParkedTicket(events: EventEnvelope[]): string | undefined {
  const seen = new Set<string>()
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as EventEnvelope
    if (e.type === 'decision/state') {
      const value = e.data as Partial<DecisionSnapshot> | null
      const id = value?.handle?.id
      if (typeof id !== 'string' || !id || seen.has(id)) continue
      seen.add(id)
      if (value?.result === null && value.consumption === null && value.invalidation === null) return id
      continue
    }
    if (e.type !== 'approval/asked') continue
    const t = (e.data as { pending?: { ticket?: unknown } } | null)?.pending?.ticket
    if (typeof t === 'string' && t) return t
  }
  return undefined
}

/**
 * The answer a `-p` run prints. `assistant/message.content` is a union of text and thinking blocks
 * (session-v1.json), and only the text half is the answer: printing thinking would put reasoning
 * the model was not asked to publish into a script's stdout.
 */
export function lastAssistantText(events: EventEnvelope[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as EventEnvelope
    if (e.type !== 'assistant/message') continue
    const content = (e.data as { content?: Array<{ type: string; text?: string }> } | null)?.content ?? []
    return content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
  }
  return ''
}
