/** Portable data and host ports for the Jev decision runtime. */

import type { Branded } from './brand.js'

/** Lossless JSON value admitted to the durable runtime protocol. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Opaque identity assigned by the runtime or its host. */
export type RecordId = Branded<'JevRecordId'>
/** Identity of one host turn. */
export type TurnId = Branded<'JevTurnId'>
/** Identity of one admitted decision step. */
export type StepId = Branded<'JevStepId'>
/** Identity of one model attempt. */
export type AttemptId = Branded<'JevAttemptId'>
/** Identity of one frozen action. */
export type IntentId = Branded<'JevIntentId'>
/** Identity of one complete candidate binding. */
export type CandidateId = Branded<'JevCandidateId'>
/** Revision of observed execution conditions. */
export type EnvironmentEpoch = Branded<'JevEnvironmentEpoch'>

/** Stable reference to bytes retained by the host for replay. */
export interface ArtifactRef {
  readonly id: string
  readonly digest: string
  readonly size: number
  readonly mediaType: string
}

/** Host-neutral model-visible content. */
export type Content =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'artifact'; readonly artifact: ArtifactRef; readonly label?: string }

/** Input or follow-up context already admitted by the host. */
export interface InputFact {
  readonly id: string
  readonly source: string
  readonly content: readonly Content[]
  /** Host codec for exact native input projection; the core never interprets it. */
  readonly snapshot?: { readonly codec: string; readonly value: JsonValue }
}

/** A tool result's instructions for the next turn, independent of DSH event types. */
export interface TurnDirective {
  readonly conclude: boolean
  readonly additions: readonly InputFact[]
}

/** Whether dispatch could affect state outside the runtime ledger. */
export type EffectClass = 'read_only' | 'workspace_mutation' | 'external_write'
/** Evidence-backed status of one dispatched action. */
export type EffectDisposition = 'none' | 'not_applied' | 'acknowledged' | 'applied' | 'unknown'
/** Host execution outcome, separate from effect disposition. */
export type ActionOutcomeKind = 'success' | 'error' | 'cancelled'
/** Role of a logged model request. */
export type ModelPurpose = 'decision' | 'parameters' | 'arbitration' | 'answer'

/** One enabled host tool; schema and revision come from the host's scoped catalog. */
export interface ToolDescriptor {
  readonly name: string
  readonly description: string
  readonly parameters: JsonValue
  readonly output: JsonValue
  readonly revision: string
  /** Missing permits all operation phases; an explicit list limits availability. */
  readonly phases?: readonly ('INSPECT' | 'ACT' | 'VERIFY')[]
  readonly effectClass?: EffectClass
  readonly defaults?: { readonly [key: string]: JsonValue }
  /** Explicit host parameter classification, checked against the current schema. */
  readonly parameterMode?: 'no_arguments' | 'parameterized'
}

/** Decision-only operation guidance captured separately from the executable host catalog. */
export interface DecisionToolProfile {
  readonly operation: string
  readonly toolRevision: string
  readonly selection: string
  readonly phases: readonly ('INSPECT' | 'ACT' | 'VERIFY')[]
  readonly inputs: string
  readonly result: string
  readonly constraints: readonly string[]
}

/** Fully bound shortcut; labels and source evidence never replace executable arguments. */
export interface Candidate {
  readonly id: CandidateId
  readonly tool: string
  readonly label: string
  readonly arguments: { readonly [key: string]: JsonValue }
  readonly sourceRecordIds: readonly RecordId[]
  readonly environmentEpoch: EnvironmentEpoch
  readonly toolRevision: string
  readonly preconditions?: JsonValue
  /** Exact fields from recorded facts used to bind the arguments. */
  readonly evidence?: readonly CandidateEvidence[]
  /** Repeated observation classified by complete evidence availability; neither value restricts execution. */
  readonly revisit?: 'evidence_missing' | 'verification'
}

/** One JSON Pointer into a recorded runtime fact and its exact value. */
export interface CandidateEvidence {
  readonly sourceRecordId: RecordId
  readonly pointer: string
  readonly value: JsonValue
}

/** Objective execution facts exposed to candidate producers without admitted user text or model proposals. */
export type CandidateFactRecord =
  | Extract<
      RuntimeRecord,
      { readonly kind: 'environment.observed' | 'resource.observed' | 'action.intended' }
    >
  | {
      readonly kind: 'candidate.invalidation'
      readonly id: RecordId
      readonly tool: string
      readonly effectClass: EffectClass
      readonly effect: EffectDisposition
    }
  | (Omit<Extract<RuntimeRecord, { readonly kind: 'action.settled' }>, 'outcome'> & {
      readonly outcome: Pick<ToolOutcome, 'kind' | 'value' | 'meta'> & {
        readonly error?: Pick<NonNullable<ToolOutcome['error']>, 'code' | 'data'>
      }
    })

/** Filtered committed facts and per-tool generation bound; rebuilt before every decision request. */
export interface CandidateContext {
  readonly records: readonly CandidateFactRecord[]
  readonly environmentRecord: Extract<RuntimeRecord, { readonly kind: 'environment.observed' }>
  readonly limit: number
  /** Complete result sources retained in the current Jev view; absent means visibility is unknown. */
  readonly visibleSourceRecordIds?: readonly RecordId[]
}

/** Host-resolved limits for each candidate producer and each candidate's field evidence. */
export interface CandidatePolicy {
  readonly maxPerTool: number
  readonly maxEvidenceBytes: number
}

/** Structured observation with optional references and coverage supplied by a tool. */
export interface Observation {
  readonly kind: string
  readonly source: string
  readonly data: JsonValue
  readonly references?: readonly { readonly kind: string; readonly id: string; readonly label: string }[]
  readonly coverage?: JsonValue
}

/** Observation linked to the durable settlement that supplied its evidence. */
export interface RecordedObservation extends Observation {
  readonly sourceRecordId: RecordId
}

/** Exactly what an adapter bound before remote model I/O, excluding credentials. */
export interface PreparedModelCall {
  readonly purpose: ModelPurpose
  readonly backend: string
  readonly endpoint: string
  readonly requestedModel: string | null
  readonly codec: string
  readonly input: JsonValue
  /** Host price evidence frozen at admission; never part of the provider wire input. */
  readonly pricing?: JsonValue
  readonly inputCursor: string | null
}

/** Provider response attribution and portable parsed output. */
export interface ModelSettlement {
  readonly output?: JsonValue
  /** Complete provider response in the named host codec, including final stream evidence. */
  readonly snapshot?: { readonly codec: string; readonly response: JsonValue }
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean }
  readonly observedModel?: string
  readonly routing?: JsonValue
  readonly usage?: JsonValue
  readonly latencyMs?: number
}

/** Decision-only view; language requests never consume this projection. */
export interface DecisionInput {
  readonly purpose: 'decision'
  readonly state: JsonValue
  readonly questions: Readonly<Record<string, JsonValue>>
  readonly inputCursor: string | null
}

/** Complete language inputs, independent of decision display budgets. */
export interface LanguageInput {
  readonly purpose: 'parameters' | 'arbitration' | 'answer'
  readonly state: JsonValue
  readonly tools?: readonly ToolDescriptor[]
  readonly lockedOperation?: string
  /** Purpose of the accepted step, retained when generating its complete arguments. */
  readonly lockedPurpose?: 'INSPECT' | 'ACT' | 'VERIFY'
  readonly history: readonly InputFact[]
  /** Committed records for deterministic language projection; adapters must not embed this graph in a request snapshot. */
  readonly records: readonly RuntimeRecord[]
  readonly inputCursor: string | null
  /** Failed request whose output format this independently recorded attempt corrects. */
  readonly repair?: {
    readonly requested: RecordId
    readonly error: { readonly code: string; readonly message: string }
  }
}

/** Purpose selects the independently owned model input. */
export type ModelInput = DecisionInput | LanguageInput

/** Host interpretation of a recorded input; replacement requires producer-declared snapshot semantics. */
export interface DecisionInputPolicy {
  readonly kind: 'task' | 'instructions' | 'context'
  /** Legacy single-value rendering used when presentation is absent; omission preserves original blocks. */
  readonly content?: JsonValue
  /** Flat Jev entries from verified host metadata; an empty list records a cleared source. */
  readonly presentation?: readonly {
    readonly label?: string
    readonly value: JsonValue
    /** Verified producer and scope of a decision rule. */
    readonly source?: string
    readonly scope?: string
    /** Native operation whose current matched profile owns this exact rule; otherwise retain the rule. */
    readonly operation?: string
    /** A section's decision role; omission uses its input policy kind. */
    readonly role?: 'constraint' | 'context' | 'capability' | 'environment' | 'resource'
  }[]
  readonly replaceKey?: string
  /** A complete producer baseline replaces its earlier baseline and deltas. */
  readonly group?: string
  readonly resetGroup?: boolean
}

/** Limits apply only to the Jev view; complete facts remain available to language requests and recovery. */
export interface DecisionContextConfig {
  readonly maxStateBytes: number
  readonly recentActions: number
  readonly observationCount: number
  readonly maxEvidenceBytes: number
  readonly excerptBytes: number
}

/** Small recorded resource facts retained independently of the action evidence window. */
export interface DecisionResourceUpdate {
  readonly name: string
  /** Complete collections replace prior members; partial observations update only their named members. */
  readonly complete: boolean
  readonly coverage: JsonValue
  readonly items: readonly {
    /** Host resource identity used internally for replacement. */
    readonly key: string
    readonly data: { readonly [key: string]: JsonValue }
    /** Omission preserves prior pending state; null clears it after a confirmed terminal observation. */
    readonly pending?: string | null
  }[]
}

/** Host-owned input interpretation and resolved decision display limits. */
export interface DecisionContextPort {
  readonly config: DecisionContextConfig
  /** Host-declared instruction priority and conflict policy, rendered as one scoped rule. */
  readonly instructionOrder: string
  /**
   * Render recorded execution facts without host transport identifiers.
   * @param facts - Persisted environment observation.
   * @returns Decision-relevant environment fields.
   */
  describeEnvironment?(facts: JsonValue): JsonValue
  /**
   * Describe a current catalog operation for Jev; absence retains its complete native description.
   * @param tool - current executable host descriptor.
   * @returns pure decision guidance or undefined when no profile is available.
   */
  describeTool?(tool: ToolDescriptor): DecisionToolProfile | undefined
  /**
   * Classify and optionally render an admitted fact without changing its original content or snapshot.
   * @param input - durable host input.
   * @returns its task role and any explicit snapshot replacement key.
   */
  classify(input: InputFact): DecisionInputPolicy
  /**
   * Describe recorded evidence using a recognized host codec; unknown codecs retain their original values.
   * Preserve evidence meaning and every coverage claim. Only redundant transport metadata may be removed.
   * Only a host-authorized rule loader may declare instructions; arbitrary result text never grants that role.
   * @param observation - committed tool evidence, never an instruction source.
   * @returns semantic evidence and source coverage, independently of display truncation; omitted coverage uses the recorded value.
   */
  describeObservation?(observation: RecordedObservation): {
    readonly data: JsonValue
    readonly coverage?: JsonValue
    readonly resources?: readonly DecisionResourceUpdate[]
    /** Complete recorded rules from a trusted loader; later loads with this key replace earlier ones. */
    readonly instruction?: {
      readonly replaceKey: string
      readonly content: JsonValue
      readonly source?: string
      readonly scope?: string
    }
  }
}

/** A distinct request owner for Jev or Laya. */
export interface DecisionBackend {
  prepare(input: DecisionInput, signal: AbortSignal): Promise<PreparedModelCall>
  invoke(call: PreparedModelCall, signal: AbortSignal): Promise<ModelSettlement>
}

/** Host LLM used only for arguments, arbitration, and final content. */
export interface LanguageBackend {
  /** Maximum additional requests for invalid JSON or forbidden tool-call output; zero disables correction. */
  readonly maxFormatRetries: number
  prepare(input: LanguageInput, signal: AbortSignal): Promise<PreparedModelCall>
  invoke(call: PreparedModelCall, signal: AbortSignal): Promise<ModelSettlement>
}

/** Host result without a second interpretation of its canonical value. */
export interface ToolOutcome {
  readonly kind: ActionOutcomeKind
  readonly value?: JsonValue
  readonly content: readonly Content[]
  readonly error?: { readonly code: string; readonly message: string; readonly data?: JsonValue }
  readonly meta?: JsonValue
  /** Host codec for exact native result projection, independent of tool metadata. */
  readonly snapshot?: { readonly codec: string; readonly value: JsonValue }
  readonly directive: TurnDirective
  readonly effect?: EffectDisposition
  readonly effectEvidence?: JsonValue
}

/** Scoped host execution, including its existing approval and guard pipeline. */
export interface ExecutionEnvironment {
  snapshot(): Promise<{ readonly epoch: EnvironmentEpoch; readonly facts: JsonValue }>
  catalog(): Promise<readonly ToolDescriptor[]>
  /** Observe workspace facts before each decision; the runtime commits them before candidate construction. */
  observe?(signal: AbortSignal): Promise<readonly JsonValue[]>
  validate(
    tool: ToolDescriptor,
    args: JsonValue,
    preconditions?: JsonValue,
  ): Promise<{ readonly [key: string]: JsonValue }>
  /** Approval and preflight only: no business effect is allowed before the dispatch barrier. */
  prepare?(
    intent: FrozenIntent,
    signal: AbortSignal,
  ): Promise<{ readonly kind: 'ready' } | { readonly kind: 'settled'; readonly outcome: ToolOutcome }>
  execute(intent: FrozenIntent, signal: AbortSignal): Promise<ToolOutcome>
  drain(intentId: IntentId): Promise<void>
}

/** Optional pure tool-owned enrichment; missing enrichment uses generic behavior. */
export interface ToolSemantics {
  /** Produce complete bindings without tool or model I/O; the caller may stop iteration at context.limit. */
  candidates(
    tool: ToolDescriptor,
    observations: readonly RecordedObservation[],
    epoch: EnvironmentEpoch,
    context?: CandidateContext,
  ): Iterable<Candidate>
  observations(tool: ToolDescriptor, result: ToolOutcome, intent: FrozenIntent): readonly Observation[]
  effectDisposition(tool: ToolDescriptor, result: ToolOutcome): EffectDisposition | undefined
}

/** Durable artifact ownership supplied by the host; retain verifies id, digest, and size without loading all bytes. */
export interface ArtifactPort {
  put(bytes: Uint8Array, mediaType: string): Promise<ArtifactRef>
  read(ref: ArtifactRef): Promise<Uint8Array>
  retain(ref: ArtifactRef): Promise<void>
  release(ref: ArtifactRef): Promise<void>
}

/** Cursor is host-owned; it may be a Session sequence, token, or compound value. */
export interface LedgerEntry<C> {
  readonly cursor: C
  readonly record: RuntimeRecord
}
/** Host log adapter; commit acknowledges only a durable prefix under a valid writer. */
export interface RuntimeLedger<C> {
  read(): Promise<readonly LedgerEntry<C>[]>
  commit(record: RuntimeRecord): Promise<C>
  cursorText(cursor: C): string
}

/** Tool call frozen before the dispatch barrier. */
export interface FrozenIntent {
  readonly id: IntentId
  readonly tool: string
  readonly toolRevision: string
  readonly arguments: { readonly [key: string]: JsonValue }
  readonly effectClass: EffectClass
  readonly environmentEpoch: EnvironmentEpoch
  readonly preconditions?: JsonValue
}

interface RecordBase {
  readonly version: 1
  readonly id: RecordId
  readonly turn: TurnId
  readonly step?: StepId
  readonly attempt?: AttemptId
}
/** Append-only runtime facts; the host owns their envelope and cursor. */
export type RuntimeRecord = RecordBase &
  (
    | { readonly kind: 'run.opened'; readonly config: RecordedRuntimeConfig; readonly runtimeVersion: string }
    | {
        readonly kind: 'environment.observed'
        readonly epoch: EnvironmentEpoch
        readonly facts: JsonValue
        readonly catalog: readonly ToolDescriptor[]
      }
    | { readonly kind: 'input.admitted'; readonly input: InputFact }
    | { readonly kind: 'resource.observed'; readonly resource: JsonValue }
    | { readonly kind: 'model.requested'; readonly call: PreparedModelCall }
    | { readonly kind: 'model.settled'; readonly requested: RecordId; readonly settlement: ModelSettlement }
    | {
        readonly kind: 'decision.selected'
        readonly requested: RecordId
        readonly phase: string
        readonly operation: string
        readonly candidateId?: CandidateId
        readonly confidence?: number
        readonly source?: 'jev' | 'llm_arbitration'
        readonly escalation?: string
        /** Index in a multi-call language proposal; absent on legacy single-call decisions. */
        readonly callIndex?: number
      }
    | { readonly kind: 'action.intended'; readonly intent: FrozenIntent; readonly decision: RecordId }
    | { readonly kind: 'action.dispatching'; readonly intentId: IntentId; readonly epoch: EnvironmentEpoch }
    | {
        readonly kind: 'action.settled'
        readonly intentId: IntentId
        readonly outcome: ToolOutcome
        readonly effect: EffectDisposition
        readonly observations: readonly Observation[]
      }
    | {
        readonly kind: 'action.resolved'
        readonly intentId: IntentId
        readonly resolution: 'confirmed_applied' | 'confirmed_not_applied' | 'accepted_uncertainty'
        readonly actor: string
        readonly explanation: string
        readonly evidence: readonly string[]
      }
    | {
        readonly kind: 'run.stopped'
        readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked' | 'budget'
        readonly detail: string
        readonly unresolved: readonly IntentId[]
      }
  )

/** Finite budgets and routing thresholds resolved before the first request. */
export interface RuntimeConfig {
  readonly maxSteps: number
  readonly maxModelAttempts: number
  readonly maxNoProgress: number
  readonly maxRepeatedFailures: number
  readonly maxCandidates: number
  readonly maxHistory: number
  readonly maxQuestionBytes: number
  readonly maxOutputBytes: number
  readonly escalateBelow: number
  /** Minimum Purpose probability mass supporting the already selected operation; not a calibrated success probability. */
  readonly equivalentSupportThreshold: number
  readonly bindingBelow: number
  readonly mutationEscalateBelow: number
  /** Historical configuration field; current runtimes require null because ambiguity is diagnostic only. */
  readonly ambiguityGate: number | null
  readonly responseReviewMode: 'diagnostic' | 'review'
  readonly answerProgressFloor: number | null
  readonly maxResponseReviewAttempts: number
}

/** Historical records omit settings introduced by later runtime versions; resume validates the owning version. */
export type RecordedRuntimeConfig = Omit<
  RuntimeConfig,
  | 'bindingBelow'
  | 'mutationEscalateBelow'
  | 'responseReviewMode'
  | 'maxResponseReviewAttempts'
  | 'equivalentSupportThreshold'
> &
  Partial<
    Pick<
      RuntimeConfig,
      | 'bindingBelow'
      | 'mutationEscalateBelow'
      | 'responseReviewMode'
      | 'maxResponseReviewAttempts'
      | 'equivalentSupportThreshold'
    >
  > & { readonly purposeDiagnostics?: boolean }

/** Host-supplied durable, model, tool, artifact, and lifecycle implementations. */
export interface RuntimePorts<C> {
  readonly ledger: RuntimeLedger<C>
  readonly decisionContext: DecisionContextPort
  readonly decision: DecisionBackend
  readonly language: LanguageBackend
  readonly environment: ExecutionEnvironment
  readonly artifacts: ArtifactPort
  readonly semantics?: ToolSemantics
  readonly candidatePolicy?: CandidatePolicy
  readonly lifecycle?: RuntimeLifecycle
}

/** Host step admission and settlement, including steering and injected context. */
export interface RuntimeLifecycle {
  /** Complete ends an empty turn without a model call or beforeStop; reject blocks it. */
  admitStep(
    turn: TurnId,
    step: StepId,
    initialInputs: readonly InputFact[],
  ): Promise<
    | {
        readonly kind: 'enter'
        readonly inputs: readonly InputFact[]
        readonly resources?: readonly JsonValue[]
      }
    | { readonly kind: 'complete' }
    | { readonly kind: 'reject' }
  >
  stepSettled(turn: TurnId, step: StepId): Promise<void>
  /** Inspect queued steering without consuming it; true invalidates the remaining batch. */
  hasPendingInput?(turn: TurnId, step: StepId): Promise<boolean>
  /** Return true only when the host admitted work that requires another decision step. */
  beforeStop?(turn: TurnId): Promise<boolean>
}

/** Terminal result of one attempted turn; unresolved effects block continuation. */
export interface RunResult {
  readonly status: 'completed' | 'cancelled' | 'failed' | 'blocked' | 'budget'
  readonly reason: string
  readonly unresolved: readonly IntentId[]
}

/** Run handle; every new instance replays the durable prefix before work. */
export interface JevRuntime {
  run(turn: TurnId, initialInputs: readonly InputFact[]): Promise<RunResult>
  resolveUnknown(
    intentId: IntentId,
    resolution: 'confirmed_applied' | 'confirmed_not_applied' | 'accepted_uncertainty',
    actor: string,
    explanation: string,
    evidence: readonly string[],
  ): Promise<void>
  cancel(): void
  close(): Promise<void>
}
