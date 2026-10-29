import type {
  GenericLoopPorts,
  LoopCheckpoint,
  LoopEndReason,
  LoopInput,
  LoopTurnView,
} from '@agnes/extension-api'

export type JsonValue = LoopCheckpoint['state']
export type JsonObject = { [key: string]: JsonValue }
export type InferenceEvent = Awaited<ReturnType<GenericLoopPorts['model']['complete']>>[number]
export type ContentBlock = LoopInput['content'][number]
export type ToolSchema = LoopTurnView['tools'][number]
export type AnnouncedContent = Array<{ type: 'text' | 'thinking'; text: string }>

export type Phase = 'INSPECT' | 'ACT' | 'VERIFY' | 'RESPOND'
export const PHASE_ORDER: readonly Phase[] = ['INSPECT', 'ACT', 'VERIFY', 'RESPOND']
export const ANSWER = 'ANSWER'
export const LLM_PARAMETERS = 'LLM_PARAMETERS'
export const DEFAULT_ARGUMENTS = 'DEFAULT_ARGUMENTS'
export type WriteClass = 'read' | 'workspace' | 'external'

export type ReferenceKind = 'file' | 'directory'
/** A workspace-relative path a tool result points at. */
export type ViewReference = { kind: ReferenceKind; value: string }
/** A bounded view of one tool result, kept as untrusted historical evidence. */
export type ObservationView = {
  id: string
  kind: string
  scope: string
  source: { operation: string; call_id: string }
  trust: 'untrusted_evidence'
  historical: true
  evidence: string
  references: ViewReference[]
  truncated: boolean
  invocation?: JsonObject
}
/** Where the references of a result came from. */
export type ReferenceSource = 'structured' | 'arguments' | 'text' | 'none'
/** A complete call Jev may pick as a target, built from an observed reference. */
export type Candidate = { key: string; kind: ReferenceKind; label: string; args: JsonObject }

export type ResolvedTool = {
  readonly name: string
  readonly phases: readonly Phase[]
  readonly writeClass: WriteClass
  readonly readOnly: boolean
  readonly profiled: boolean
  readonly criteria: string
  readonly targetParam: string | null
  readonly defaults: JsonObject | null
  readonly multiTargetMax: number
  /** The non-path arguments of a call built from an observed reference, or `null` when the tool has none. */
  readonly bindingDefaults: JsonObject | null
  /** The kind of reference the tool's target path takes, or `null` when it takes none. */
  readonly referenceKind: ReferenceKind | null
}

export type CompiledQuestions = {
  readonly questions: JsonObject
  readonly phaseActions: Readonly<Partial<Record<Phase, readonly string[]>>>
  readonly actionHeads: Readonly<Partial<Record<Phase, string>>>
  readonly actionConstants: Readonly<Partial<Record<Phase, string>>>
  /** Keyed `${phase}/${op}`. */
  readonly targetHeads: Readonly<Record<string, string>>
  readonly targetConstants: Readonly<Record<string, string>>
  readonly targetOptions: Readonly<Record<string, readonly string[]>>
  /** op → complete DEFAULT_ARGUMENTS. */
  readonly defaults: Readonly<Record<string, JsonObject>>
  /** Keyed `${phase}/${op}`: the observed candidates offered by the target head. */
  readonly targetCandidates: Readonly<Record<string, readonly Candidate[]>>
  /** Keyed `${phase}/${op}`: the head choosing between one target and several. */
  readonly modeHeads: Readonly<Record<string, string>>
  /** Keyed `${phase}/${op}`, then candidate key: the head including that candidate in a batch. */
  readonly memberHeads: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Keyed `${phase}/${op}`: the most targets one step may take. */
  readonly multiTargetMax: Readonly<Record<string, number>>
}

export type ConsumedHead = {
  readonly role: 'phase' | 'action' | 'target' | 'target_mode' | 'target_member' | 'target_fallback'
  readonly head: string | null
  readonly selected: string
  readonly confidence: number | null
  readonly deterministic: boolean
}

export type Decision = {
  readonly phase: Phase
  readonly op: string
  readonly target: string | readonly string[]
  readonly bindingMode: 'observed' | 'defaults' | 'llm_parameters'
  readonly args: JsonObject
  /** The arguments of every call of a batch; only present for two or more observed targets. */
  readonly batch?: readonly JsonObject[]
  readonly confidence: number
  readonly operationPathConfidence: number
  readonly targetConfidence: number | null
  readonly ambiguity: number | null
  readonly progress: number | null
  readonly phaseTop: ReadonlyArray<readonly [string, number]>
  readonly actionTop: ReadonlyArray<readonly [string, number]>
  readonly consumed: readonly ConsumedHead[]
}

export type RouteKind = 'direct' | 'parameters' | 'arbitration' | 'answer'
export type RouteReason =
  | 'low_confidence'
  | 'recoverable_observation'
  | 'premature_answer'
  | 'weak_binding'
  | null
export type Route = { readonly kind: RouteKind; readonly reason: RouteReason; readonly decision: Decision }
export type LlmKind = Exclude<RouteKind, 'direct'>

export type ErrorStage = 'decision' | 'llm' | 'dispatch' | 'finish'
export type StepError = {
  code: string
  kind: 'infrastructure' | 'proposal' | 'execution' | 'policy'
  stage: ErrorStage
  recoverability: 'recoverable' | 'unsafe' | 'terminal'
  message: string
}
export type HistoryEntry = {
  phase: Phase | null
  operation: string | null
  target: string | string[] | null
  status: 'succeeded' | 'failed' | 'refused' | 'held'
  disposition: 'SUCCEEDED' | 'NOT_APPLIED' | 'UNKNOWN'
  exit?: number
  summary: string
  error?: StepError
  read_files?: string[]
  changed_files?: string[]
  files_may_have_changed?: boolean
  command_excerpt?: string
  output_excerpt?: string
  intentFp: string | null
  observationFp: string
  dispatched: boolean
}
export type Note = { kind: 'file' | 'shell' | 'steer'; target?: string; text: string }
export type Observation = {
  entry: HistoryEntry
  notes: Note[]
  view?: ObservationView
  refs?: { source: ReferenceSource; count: number }
}
export type Workspace = {
  goal: string
  previousAnswer: string
  answer: string
  notes: Note[]
  history: HistoryEntry[]
  turnStart: number
  views: ObservationView[]
}

export type JevLoopConfig = {
  jev: { route: string; model: string; deadlineMs: number; maxRetries: number }
  llmMaxAttempts: number
  thresholds: {
    escalate: number
    externalWriteMin: number
    ambiguityGate: number | null
    answerProgressFloor: number | null
  }
  stepCap: number
  stateTokenBudget: number
  requestTokenBudget: number
}

export type Stage = 'idle' | 'decide' | 'llm' | 'dispatch' | 'finish' | 'parked' | 'done'
export type PendingCall = {
  invocationId: string
  name: string
  args: JsonValue
  announce: 'true' | 'content'
  content?: AnnouncedContent
}
export type CurrentStep = {
  jevAttempts: string[]
  level: number
  decision?: Decision
  route?: { kind: RouteKind; reason: RouteReason }
  /** `counted`: the attempts of this step a restart has already added to the counters. */
  llm?: { kind: LlmKind; attempt: number; note?: string; counted?: number }
  calls?: PendingCall[]
}
export type Counters = {
  jevCalls: number
  jevRetries: number
  decisionFailures: { MODEL_UNAVAILABLE: number; INVALID_PROPOSAL: number }
  llm: { parameters: number; arbitration: number; answer: number; retries: number }
  directSteps: number
  directSuccess: number
  arbitrationAgreed: number
  arbitrationOverturned: number
  droppedCalls: number
  answerDeclined: number
  noCall: number
  emitted: number
  droppedEvents: number
  observedSteps: number
  batchSteps: number
  textReferences: number
  duplicateRefusals: number
  unavailableRefusals: number
}
export type JevState = {
  v: 1
  idTurn: number | null
  coreTurn: number | null
  stage: Stage
  step: number
  toolNames: string[]
  toolNamesChanges: number
  cur: CurrentStep
  pendingNotes: string[]
  workspace: Workspace
  counters: Counters
  internalErrors: number
  endReason?: LoopEndReason
  endError?: { code: string; message: string }
}
