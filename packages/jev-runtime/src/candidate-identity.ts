/** Invocation identity shared by candidate allocation and question validation. */
import type { Candidate, JsonValue } from './types.js'

function ordered(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(ordered).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${ordered(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Identify an invocation independently of its receipt, label, and object key order.
 * @param candidate - Binding whose arguments have passed host validation.
 * @returns Identity for one tool revision, environment, and complete argument value.
 * Preconditions must be checked before discarding an alternative with this identity.
 */
export function candidateInvocationKey(candidate: Candidate): string {
  return ordered([candidate.tool, candidate.toolRevision, candidate.environmentEpoch, candidate.arguments])
}
