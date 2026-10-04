import type { FrozenIntent, ModelSettlement, PreparedModelCall, RuntimeRecord } from '@agnes/jev-runtime'
import type { ToolCall } from '@agnes/protocol'
import { stableJson } from './language-projection.js'

/** Only a causally linked, recorded native arbitration call owns an assistant tool turn. */
export function nativeAuthoredCall(
  decision: Extract<RuntimeRecord, { kind: 'decision.selected' }> | undefined,
  request: PreparedModelCall | undefined,
  settlement: ModelSettlement | undefined,
  intent: FrozenIntent,
): ToolCall | undefined {
  if (
    decision?.source !== 'llm_arbitration' ||
    request?.purpose !== 'arbitration' ||
    settlement?.error !== undefined ||
    settlement?.snapshot?.codec !== 'agnes-inference-v1'
  )
    return undefined
  const response = settlement.snapshot.response
  if (
    response === null ||
    typeof response !== 'object' ||
    Array.isArray(response) ||
    !Array.isArray(response.events)
  )
    return undefined
  const calls = response.events.filter(
    (event) =>
      event !== null && typeof event === 'object' && !Array.isArray(event) && event.type === 'toolcall_end',
  )
  const index = decision.callIndex === undefined ? (calls.length === 1 ? 0 : undefined) : decision.callIndex
  if (
    calls.length > 32 ||
    index === undefined ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= calls.length
  )
    return undefined
  const event = calls[index]
  if (event === null || typeof event !== 'object' || Array.isArray(event) || event.via !== 'native')
    return undefined
  const call = event.call
  if (
    call === null ||
    typeof call !== 'object' ||
    Array.isArray(call) ||
    call === undefined ||
    typeof call.toolUseId !== 'string' ||
    call.toolUseId.length === 0 ||
    call.toolUseId.length > 128 ||
    call.name !== intent.tool ||
    decision.operation !== intent.tool ||
    !Number.isSafeInteger(call.ordinal) ||
    typeof call.ordinal !== 'number' ||
    call.ordinal < 0 ||
    stableJson(call.args) !== stableJson(intent.arguments)
  )
    return undefined
  return {
    toolUseId: call.toolUseId,
    name: intent.tool,
    args: structuredClone(intent.arguments),
    ordinal: call.ordinal,
  }
}
