import type { EventEnvelope, TurnEndReason } from '@agnes/protocol'

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
 * The ticket a parked turn left behind, which is what `agnes resume` is given. Scanned backwards
 * because a turn can ask more than once and only the last ask is the one still open; rows that ask
 * without parking carry no `pending`, so they are skipped rather than treated as the answer.
 *
 * The shape is core's, not the protocol schema's: `approval/asked` has no `$def` in session-v1.json,
 * so `data` is JsonValue on the wire and the reading is written defensively here.
 */
export function findParkedTicket(events: EventEnvelope[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as EventEnvelope
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
