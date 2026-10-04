/** Serializable Jev trace view shared by Host and Browser. */

import type {
  AttemptId,
  CandidateId,
  IntentId,
  JsonValue,
  ModelPurpose,
  RecordId,
  RuntimeRecord,
  StepId,
  TurnId,
} from '@agnes/jev-runtime'

/** One observed runtime fact in host Session order; time is host observation time. */
export interface TraceEntry {
  readonly seq: number
  readonly time: number
  readonly turn: number
  readonly step?: number
  readonly record: RuntimeRecord
}

/** One recorded option from a submitted question or an omitted manifest constant. */
export interface TraceOption {
  readonly key: string
  readonly criterion: JsonValue
  readonly selected: boolean
  /** Present only for a validated consumed or supporting choice distribution. */
  readonly probability?: number
}

/** A submitted question or manifest constant with its observed, validated path state. */
export interface TraceHead {
  readonly key: string
  readonly role: 'phase' | 'action' | 'binding' | 'other'
  readonly status: 'pending' | 'unconsumed' | 'consumed' | 'supporting' | 'deterministic' | 'invalid'
  readonly options: readonly TraceOption[]
  readonly selected?: string
  readonly confidence?: number
}

/** One model request and its optional settlement in Session order. */
export interface TraceRequest {
  readonly id: RecordId
  readonly attempt?: AttemptId
  readonly requestedSeq: number
  readonly requestedTime: number
  readonly purpose: ModelPurpose
  readonly backend: string
  readonly requestedModel: string | null
  readonly status: 'pending' | 'settled' | 'failed'
  readonly settledSeq?: number
  readonly settledTime?: number
  readonly observedModel?: string
  readonly usage?: JsonValue
  readonly latencyMs?: number
  readonly heads: readonly TraceHead[]
}

/** One accepted route; an arbitration decision remains distinct from the original Jev choice. */
export interface TraceDecision {
  readonly id: RecordId
  readonly seq: number
  readonly time: number
  readonly requested: RecordId
  readonly purpose: 'decision' | 'arbitration'
  readonly phase: string
  readonly operation: string
  readonly candidateId?: CandidateId
  readonly confidence?: number
  readonly escalation?: string
}

/** One frozen tool action and the barriers observed so far. */
export interface TraceAction {
  readonly intentId: IntentId
  readonly decisionId: RecordId
  readonly intendedSeq: number
  readonly intendedTime: number
  readonly tool: string
  readonly arguments: { readonly [key: string]: JsonValue }
  readonly status: 'intended' | 'dispatching' | 'settled' | 'unknown' | 'resolved'
  readonly dispatchingSeq?: number
  readonly settledSeq?: number
  readonly outcome?: RuntimeRecord & { readonly kind: 'action.settled' }
  readonly resolutionSeq?: number
  readonly resolution?: RuntimeRecord & { readonly kind: 'action.resolved' }
}

/** Final run reason as of the selected prefix. */
export interface TraceStop {
  readonly seq: number
  readonly time: number
  readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked' | 'budget'
  readonly detail: string
  readonly unresolved: readonly IntentId[]
}

/** One host step with request, route, and tool histories in source order. */
export interface TraceStep {
  readonly id?: StepId
  readonly number: number
  readonly firstSeq: number
  readonly lastSeq: number
  readonly requests: readonly TraceRequest[]
  readonly decisions: readonly TraceDecision[]
  readonly originalDecision?: TraceDecision
  readonly finalDecision?: TraceDecision
  readonly actions: readonly TraceAction[]
}

/** A turn can receive a later resolution after its stop record. */
export interface TraceTurn {
  readonly id: TurnId
  readonly number: number
  readonly firstSeq: number
  readonly lastSeq: number
  readonly steps: readonly TraceStep[]
  readonly stops: readonly TraceStop[]
  readonly actions: readonly TraceAction[]
}

/** Fully JSON-serializable projection of the observed prefix. */
export interface TraceView {
  readonly throughSeq: number | null
  readonly turns: readonly TraceTurn[]
}
