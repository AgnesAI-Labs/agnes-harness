import type { ToolCall } from '@agnes/protocol'

// The id rule of the Model service's paired tool history (`TOOL_USE_ID` in the core wire builder). A returned
// call is replayed in the next round's history, so an id the builder would refuse there is refused here.
// @agnes/ai cannot import core: a host test fails when the two rules diverge.
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The detail code for a returned tool call the next request could not carry, or null. `rawArguments` is the
 * argument text the provider streamed for this call; a provider that sent none is not malformed.
 */
export function toolCallRefusal(call: ToolCall, rawArguments: string): string | null {
  if (typeof call.toolUseId !== 'string' || !TOOL_USE_ID.test(call.toolUseId)) return 'model_tool_call_id'
  if (rawArguments.trim() === '') return null
  try {
    JSON.parse(rawArguments)
  } catch {
    return 'model_tool_call_arguments'
  }
  return null
}
