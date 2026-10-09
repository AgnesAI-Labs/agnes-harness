import type { Actor, JsonValue } from '@agnes/protocol'
import type { ToolResult } from './tool.js'

/** Durable plugin-agnostic work. Validation is not authorization: execute/resume still owns policy. */
export interface DeferredToolInvocation {
  id: string
  sessionKey: string
  lane: string
  source: string
  sourceSeq: number
  actor: Actor
  tool: string
  args: JsonValue
}
export type DeferredInvocationState = 'queued' | 'executing' | 'pending-approval' | 'succeeded' | 'failed'
export interface DeferredInvocationReceipt {
  invocation: DeferredToolInvocation
  state: DeferredInvocationState
  seq: number
  resultSeq?: number
  toolCallSeq?: number
  approvalId?: string
  result?: ToolResult
  error?: { code: string; message: string; outcomeUnknown: boolean; retryable: boolean }
}
/** Host-owned durable ports. Scan includes only this lane's trusted invocation facts. */
export interface DeferredInvocationLedgerPort {
  scan(): Promise<readonly import('@agnes/protocol').EventEnvelope[]>
  append(type: string, data: JsonValue, actor: Actor, sourceSeq?: number): Promise<number>
  outcome(
    id: string,
  ): Promise<{ resultSeq?: number; toolCallSeq?: number; approvalId?: string; result?: ToolResult }>
  wake(id: string, actor: Actor, signal: AbortSignal): Promise<void>
}
/** One lane, bound by Host; every mutation is durable before returning. Never an authorization port. */
export interface DeferredToolInvocationQueue {
  readonly sessionKey: string
  readonly lane: string
  enqueue(invocation: DeferredToolInvocation, signal: AbortSignal): Promise<DeferredInvocationReceipt>
  /** Returns the oldest unfinished invocation. Terminal receipts remain readable after notification. */
  next(signal: AbortSignal): Promise<DeferredInvocationReceipt | null>
  read(id: string, signal: AbortSignal): Promise<DeferredInvocationReceipt | null>
  transition(
    id: string,
    expectedSeq: number,
    state: DeferredInvocationState,
    outcome?: Pick<DeferredInvocationReceipt, 'result' | 'error'>,
  ): Promise<DeferredInvocationReceipt>
  /** Idempotent producer notification; retry missing delivery after restart without rerunning tools. */
  notify(signal: AbortSignal): Promise<void>
}
/** Producer callbacks receive an owner-bound session, never another plugin's queue authority. */
export interface DeferredInvocationProducer {
  source: string
  validate(invocation: DeferredToolInvocation, signal: AbortSignal): Promise<void>
  changed(receipt: DeferredInvocationReceipt, signal: AbortSignal): Promise<void>
}
export interface DeferredInvocationRegistryPort {
  register(producer: DeferredInvocationProducer): () => void
  forSession(sessionKey: string, lane: string): DeferredToolInvocationQueue | undefined
}
