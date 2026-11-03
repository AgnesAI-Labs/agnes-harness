import type { RefinementSettings } from '../gen/ts/agnes-v1.js'

/** Refinement is opt-in: a profile without saved settings has it off, in manual mode. */
export const DEFAULT_REFINEMENT_SETTINGS: RefinementSettings = Object.freeze({
  enabled: false,
  mode: 'manual',
})

/** The first line of the note that delivers saved entries to the model. */
export const TASK_EXPERIENCE_NOTE_PREFIX = '[task-experience]\n'

/** What stands in a compaction's text where a delivered experience note was. */
const TASK_EXPERIENCE_PLACEHOLDER = '[task experience note omitted]'

/**
 * The text that stands in for a delivered experience note in text built from a conversation, or
 * undefined for any other message: a runtime-context message whose first text block is the note's
 * header. Only the message data is looked at, so a compaction engine, which is not told a node's
 * origin, can use it: only the harness writes `runtime_context`.
 */
export function lessonNotePlaceholder(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object' || (data as { kind?: unknown }).kind !== 'runtime_context')
    return undefined
  const content = (data as { content?: unknown }).content
  const block = Array.isArray(content) ? content[0] : undefined
  const first =
    block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      ? String((block as { text?: unknown }).text)
      : undefined
  return first?.startsWith(TASK_EXPERIENCE_NOTE_PREFIX) ? TASK_EXPERIENCE_PLACEHOLDER : undefined
}
