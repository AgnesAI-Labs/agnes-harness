import type { JsonValue, ModelSettlement } from '@agnes/jev-runtime'
import type { RequestMessage } from '@agnes/protocol'

/** Verified assistant history recovered from a successful language settlement. */
export interface AssistantSettlement {
  readonly content: Extract<RequestMessage, { role: 'assistant' }>['content']
}

function object(value: unknown): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function answerOutput(
  output: JsonValue | undefined,
): output is { readonly kind: 'answer'; readonly content: JsonValue[] } {
  return object(output) && output.kind === 'answer' && Array.isArray(output.content)
}

function replayEvents(
  events: readonly JsonValue[],
): { content: AssistantSettlement['content']; text: string } | undefined {
  const content: Array<{ type: 'text' | 'thinking'; text: string }> = []
  let text = ''
  let finished = false
  for (const event of events) {
    if (finished || !object(event) || typeof event.type !== 'string') return undefined
    switch (event.type) {
      case 'sent':
      case 'usage':
      case 'deviation':
        continue
      case 'thinking_delta':
      case 'text_delta': {
        if (typeof event.delta !== 'string') return undefined
        const type = event.type === 'text_delta' ? 'text' : 'thinking'
        if (type === 'text') text += event.delta
        const previous = content.at(-1)
        if (previous?.type === type) previous.text += event.delta
        else content.push({ type, text: event.delta })
        continue
      }
      case 'done':
        if (event.reason !== 'stop') return undefined
        finished = true
        continue
      default:
        return undefined
    }
  }
  return finished && text.trim() !== '' ? { content, text } : undefined
}

/**
 * Recover the assistant message from a successful agnes-inference-v1 answer settlement.
 * Stream terminal state and visible text must match the portable output; thinking is restored
 * from the verified events. Returns undefined for another outcome or a damaged snapshot.
 */
export function readAssistantSettlement(settlement: ModelSettlement): AssistantSettlement | undefined {
  if (settlement.error !== undefined || !answerOutput(settlement.output)) return undefined
  if (settlement.snapshot?.codec !== 'agnes-inference-v1') return undefined
  const response = settlement.snapshot.response
  if (!object(response) || !Array.isArray(response.events)) return undefined
  const replayed = replayEvents(response.events)
  if (replayed === undefined) return undefined
  const portable: JsonValue[] = [{ kind: 'text', text: replayed.text }]
  if (JSON.stringify(portable) !== JSON.stringify(settlement.output.content)) return undefined
  return { content: replayed.content }
}

/**
 * Require a verified native stream before publishing a new accepted answer.
 * Snapshot-less output is not a successful record.
 */
export function requireAssistantSettlement(settlement: ModelSettlement): AssistantSettlement {
  const native = readAssistantSettlement(settlement)
  if (native === undefined) throw new Error('Completed Agnes answer lacks its native model stream')
  return native
}

/**
 * Restore assistant RequestMessage content for an already admitted answer.
 * Verified agnes-inference-v1 snapshots include thinking; snapshot-less legacy answers keep their
 * portable text. A present but invalid snapshot is refused rather than replaced with output text.
 */
export function assistantHistoryContent(
  settlement: ModelSettlement,
): Extract<RequestMessage, { role: 'assistant' }>['content'] {
  const native = readAssistantSettlement(settlement)
  if (native !== undefined) return native.content
  if (settlement.snapshot !== undefined)
    throw new Error('Completed Agnes answer lacks its native model stream')
  if (!answerOutput(settlement.output)) return []
  return settlement.output.content.flatMap((block) =>
    object(block) && block.kind === 'text' && typeof block.text === 'string'
      ? [{ type: 'text' as const, text: block.text }]
      : [],
  )
}

export function isAnswerOutput(output: JsonValue | undefined): boolean {
  return answerOutput(output)
}
