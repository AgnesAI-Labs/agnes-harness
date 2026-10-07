import type { ExecutionDomain, ResolvedToolCallPolicy } from '@agnes/protocol'
import type { AssistantMessage } from '@agnes/protocol/gen/session-v1'
import type { SessionRef } from './common.js'
import type { HookPayloadMap, HookReturnMap } from './hooks.js'
import type { LoopEndReason } from './loop.js'

/** Request/tool events share the existing hook payloads and permitted transforms. */
export interface LoopEventPayloadMap {
  before_model_request: HookPayloadMap['before_request']
  after_model_response: { content: AssistantMessage['content']; stopReason: string }
  before_tool_call: HookPayloadMap['tool_call'] & {
    resolvedPolicy: ResolvedToolCallPolicy
    executionDomain: ExecutionDomain
    definitionFingerprint: string
    policyHash: string
  }
  after_tool_result: HookPayloadMap['tool_result']
  turn_end: { turn: number; reason: LoopEndReason }
}
export interface LoopEventReturnMap {
  before_model_request: HookReturnMap['before_request']
  after_model_response: void
  before_tool_call: HookReturnMap['tool_call']
  after_tool_result: HookReturnMap['tool_result']
  turn_end: void
}
export type LoopEventName = keyof LoopEventPayloadMap
export const LOOP_EVENTS = [
  'before_model_request',
  'after_model_response',
  'before_tool_call',
  'after_tool_result',
  'turn_end',
] as const
export interface LoopEventContext {
  readonly session: SessionRef
  readonly signal: AbortSignal
}
export type LoopEventHandler<E extends LoopEventName> = (
  payload: LoopEventPayloadMap[E],
  context: LoopEventContext,
) => LoopEventReturnMap[E] | Promise<LoopEventReturnMap[E]>
export interface LoopEventRegistration {
  on<E extends LoopEventName>(event: E, handler: LoopEventHandler<E>): () => void
}
export interface LoopEventPort {
  /** Existing request/tool hooks run once, then event listeners form a waterfall. */
  dispatch?<E extends LoopEventName>(
    event: E,
    payload: LoopEventPayloadMap[E],
    signal: AbortSignal,
  ): Promise<LoopEventReturnMap[E]>
}
export interface LoopEventRegistryPort extends LoopEventRegistration {
  dispatch<E extends LoopEventName>(
    event: E,
    payload: LoopEventPayloadMap[E],
    context: LoopEventContext,
  ): Promise<LoopEventReturnMap[E]>
}
export interface LoopEventsPluginContext {
  loopEvents: LoopEventRegistration
}
