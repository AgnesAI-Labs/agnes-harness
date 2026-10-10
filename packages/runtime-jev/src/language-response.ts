/** Convert native model proposals into portable, unexecuted language results. */

import type { ModelSettlement } from '@agnes/jev-runtime'
import { durableJson } from './model-json.js'

/** One native function proposal, before routing and argument-schema validation. */
export interface LanguageToolCall {
  readonly name: string
  readonly arguments: string
}

/**
 * Decode a complete native proposal without granting execution authority.
 * The runtime checks tool availability, any operation lock, and the argument schema.
 * @param purpose - parameter completion or next-action selection.
 * @param text - assistant text, excluding reasoning blocks.
 * @param calls - native function calls in the completed response.
 * @returns portable proposal or a bounded, retryable format failure.
 */
export function decodeLanguageResponse(
  purpose: 'parameters' | 'arbitration',
  text: string,
  calls: readonly LanguageToolCall[],
): Pick<ModelSettlement, 'output' | 'error'> {
  const sentence = text.trim()
  if (calls.length === 0 && sentence.length > 0)
    return {
      output:
        purpose === 'parameters'
          ? { kind: 'cannot_bind', reason: sentence }
          : { kind: 'answer', content: [{ kind: 'text', text }] },
    }
  if (calls.length === 0 || calls.length > 32)
    return {
      error: {
        code: 'LANGUAGE_TOOL_CALL',
        message: 'Call between 1 and 32 tools, or explain why no tool call is appropriate.',
        retryable: true,
      },
    }
  try {
    // Validate every proposal before returning any of the batch to runtime admission.
    const proposals = calls.map((call) => {
      const value: unknown = JSON.parse(call.arguments)
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('Tool arguments must be an object')
      return { kind: 'call', name: call.name, arguments: durableJson(value) }
    })
    const first = proposals[0]
    return {
      output: proposals.length === 1 && first !== undefined ? first : { kind: 'calls', calls: proposals },
    }
  } catch (_error) {
    return {
      error: {
        code: 'LANGUAGE_INVALID_JSON',
        message: 'Every tool call must contain one complete JSON object with finite values.',
        retryable: true,
      },
    }
  }
}
