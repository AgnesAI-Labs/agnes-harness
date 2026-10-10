import type {
  LoopInput,
  OwnerLedgerPort,
  ServiceInstance,
  ServicePorts,
  ToolResult,
} from '@agnes/extension-api'
import { defineServiceKind } from '@agnes/extension-api'

/** Protocol actor, read from the loop input so this package does not import protocol. */
export type DeferredActor = LoopInput['actor']
/** JSON value accepted by an owner ledger append. */
export type DeferredJson = Parameters<OwnerLedgerPort['appendOwn']>[1]

/** Durable plugin-agnostic work. Validation is not authorization: execute/resume still owns policy. */
export interface DeferredToolInvocation {
  id: string
  sessionKey: string
  lane: string
  source: string
  sourceSeq: number
  actor: DeferredActor
  tool: string
  args: DeferredJson
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

/** One lane. Every mutation is durable before returning. Never an authorization port. */
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

/** Callbacks for one owner. The host supplies the owner; the instance does not claim a source. */
export interface DeferredProducerInstance extends ServiceInstance {
  validate(invocation: DeferredToolInvocation, signal: AbortSignal): Promise<void>
  changed(receipt: DeferredInvocationReceipt, signal: AbortSignal): Promise<void>
}

/** Host-verified producer. `source` is the verified owner key, not a value the plugin asserts. */
export interface DeferredInvocationProducer extends DeferredProducerInstance {
  readonly source: string
}

export interface DeferredQueueInstance extends DeferredToolInvocationQueue, ServiceInstance {}

/** One queue per session and lane. The loop reads it; a plugin does not register an implementation. */
export const deferredQueueKind = defineServiceKind<DeferredQueueInstance, ServicePorts>({
  kind: 'deferred-invocations',
  cardinality: 'single',
  instanceScope: 'session',
  scope: 'session',
  ports: [],
})

/** One registration per owner. Each admitted call opens its own instance. */
export const deferredProducerKind = defineServiceKind<DeferredProducerInstance, ServicePorts>({
  kind: 'deferred-producer',
  cardinality: 'multi',
  instanceScope: 'session',
  scope: 'generation',
  ports: [],
})
