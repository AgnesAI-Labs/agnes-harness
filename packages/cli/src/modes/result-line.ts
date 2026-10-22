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
  /** `--output-schema`: the final reply parsed and validated. */
  structured?: unknown
}

/** One line, machine-first: the last thing `--mode json` writes, and the only thing it promises. */
export function cliResultLine(o: CliResult): string {
  return `${JSON.stringify({ v: RESULT_V, ...o })}\n`
}

export const EVENT_V = 'agnes-cli-event/v1' as const

/** One session event per line, as it arrives: what `--mode stream-json` writes before the result line. */
export function cliEventLine(event: EventEnvelope): string {
  return `${JSON.stringify({ schema: EVENT_V, event })}\n`
}

/**
 * The current unanswered decision a parked turn left behind. Read only each handle's latest
 * state so an answered, consumed or invalidated request cannot revive its earlier open state.
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
    }
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
