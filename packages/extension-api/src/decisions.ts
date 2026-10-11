import type { JsonValue } from '@agnes/protocol'
import type { DecisionAggregate, DecisionAction, DecisionLifecyclePolicy, DecisionSubject,
  DecisionPresentation, DecisionSnapshot, DecisionPage, DecisionHandle, DecisionAnswered,
  DecisionUnanswered } from '@agnes/protocol/gen/session-v1'
import type { ServiceKindToken } from './service-provider.js'
export type { DecisionAggregate, DecisionSubject, DecisionPresentation, DecisionAction,
  DecisionLifecyclePolicy, DecisionAuthority, DecisionRequestRecord, DecisionSnapshot,
  DecisionPage, DecisionExecution, DecisionGrantLink, DecisionScope, DecisionPrincipal,
  DecisionAnsweredBy, DecisionCause, DecisionHandle } from '@agnes/protocol/gen/session-v1'

export type DecisionResult<R extends JsonValue = JsonValue> =
  | (Omit<DecisionAnswered, 'response'> & { readonly response: R })
  | DecisionUnanswered

export interface ContinuationCodec<S extends JsonValue = JsonValue> {
  readonly id: string
  readonly version: number
  readonly schema: Readonly<Record<string, JsonValue>>
  encode(state: S): JsonValue
  decode(data: JsonValue): S
}
export interface DecisionContinuationSpec {
  readonly codecId: string
  readonly codecVersion: number
  readonly data: JsonValue
}
export interface DecisionSpec {
  readonly kind: string
  readonly kindVersion: number
  readonly sourceKey: string
  readonly subject: DecisionSubject
  readonly responseSchema: Readonly<Record<string, JsonValue>>
  readonly actions: readonly DecisionAction[]
  readonly presentation: DecisionPresentation
  readonly continuation: DecisionContinuationSpec
  readonly lifecycle?: Partial<DecisionLifecyclePolicy>
}
export interface DecisionWaitOptions {
  readonly waitBudget?: number
  readonly signal?: AbortSignal
}
export type DecisionWaitResult<R extends JsonValue = JsonValue> =
  | { readonly status: 'resolved'; readonly handle: DecisionHandle; readonly result: DecisionResult<R> }
  | {
      readonly status: 'pending'
      readonly handle: DecisionHandle
      readonly waitEndedBy: 'budget' | 'detached'
    }
export interface DecisionPort {
  request(spec: DecisionSpec): Promise<DecisionHandle>
  get(handle: DecisionHandle): Promise<DecisionSnapshot>
  list(query?: { readonly cursor?: string; readonly limit?: number }): Promise<DecisionPage>
  wait<R extends JsonValue = JsonValue>(
    handle: DecisionHandle, options?: DecisionWaitOptions,
  ): Promise<DecisionWaitResult<R>>
}
export type DecisionResumeTarget =
  | { readonly type: 'loop'; readonly id: string; readonly version: string }
  | { readonly type: 'tool'; readonly name: string }
  | { readonly type: 'service'; readonly kind: ServiceKindToken; readonly providerId: string; readonly version: string }
export interface DecisionKindDefinition {
  readonly kind: string
  readonly version: number
  readonly responseSchema: Readonly<Record<string, JsonValue>>
  readonly actions: readonly DecisionAction[]
  readonly codec: ContinuationCodec
  readonly resumeTarget: DecisionResumeTarget
}
export interface DecisionRegistryPort {
  register(definition: DecisionKindDefinition): () => Promise<void>
}
export interface DecisionPluginContext {
  readonly decisionKinds: DecisionRegistryPort
  readonly decisions: DecisionPort
}

const lifecycle = (expireAfter: number | null, onStop: 'cancel' | 'suspend') =>
  Object.freeze({ expireAfter, waitBudget: 0, onUnavailable: 'park' as const, onStop })
const short = lifecycle(600000, 'cancel')
const day = lifecycle(86400000, 'cancel')
const durable = lifecycle(null, 'suspend')
export const DEFAULT_DECISION_LIFECYCLES = Object.freeze({
  'tool.permission': short,
  'budget.quote': lifecycle(300000, 'cancel'),
  'execution.reconcile': durable,
  'verifier.accept-result': day,
  'verifier.request-revision': day,
  'memory.write': short,
  'resource.mcp-connect': short,
  'skill.read-source': short,
  'skill.install': short,
  'package.test': short,
  'package.publish': durable,
  'plan.exit': day,
  'harness.refine': day,
  'interaction.question': durable,
  'business.confirm': day,
})
export const DEFAULT_CUSTOM_DECISION_LIFECYCLE = short

/** Required contexts receive a refusing port when no admission grants a scope. */
export const unavailableDecisions: DecisionPort = Object.freeze({
  request: async () => { throw new Error('E_DECISION_SCOPE: no admitted decision scope') },
  get: async () => { throw new Error('E_DECISION_SCOPE: no admitted decision scope') },
  list: async () => { throw new Error('E_DECISION_SCOPE: no admitted decision scope') },
  wait: async () => { throw new Error('E_DECISION_SCOPE: no admitted decision scope') },
})
