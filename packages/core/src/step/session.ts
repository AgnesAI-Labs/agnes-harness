import type {
  HookPayloadMap,
  ToolRuntime,
  ToolRuntimeProvider,
  ToolRuntimeRegistryPort,
  ToolPolicyRegistryPort,
  LoopEventRegistryPort,
  HookReturnMap,
  Logger,
  LoopContext,
  LoopDriver,
  LoopFactory,
  LoopSelection,
  LoopStepOutcome,
  ToolContext,
  ToolMeta,
  ToolResult,
} from '@agnes/extension-api'
import { ToolPolicyRegistry, ToolRuntimeRegistry } from '../effects/tool-providers.js'
import { LoopEventRegistry, loopEventContext } from '../loop/events.js'
import type {
  Actor,
  ApprovalMode,
  ContentBlock,
  ExecutionDomain,
  InferenceEvent,
  ModelRecord,
  Provider,
  RequestBody,
  RequestMediaHeader,
  ResolvedToolCallPolicy,
  SessionStart,
  ThinkingLevel,
  UISpan,
  UITurn,
} from '@agnes/protocol'
import {
  inspectJsonData,
  MAX_FRAME_BYTES,
  modelImageInputError,
  UI_HISTORY_DEFAULT_LIMIT,
  UI_OPENING_DEFAULT_MAX_NODES,
  UI_PROJECTION_DEFAULT_MAX_BYTES,
  validateActor,
} from '@agnes/protocol'
import { unbindChildFactory } from '../child/sessions.js'
import { hasChildControl } from '../child/store.js'
import { isPending, normalizeApproval } from '../effects/approval-answer.js'
import { EffectRuntime } from '../effects/effect.js'
import { type ExecuteAttempt, ExecutePermitRegistry } from '../effects/execute-permits.js'
import { type NestedToolLease, NestedToolScheduler } from '../effects/scheduler.js'
import type { ApprovalAnswer, ApprovalRequest, Pending, Verdict, VerifierVerdict } from '../effects/seams.js'
import type { ChildrenFactory, ToolContextDeps } from '../effects/tool-context.js'
import {
  assertToolDispatchAvailable,
  dispatchTool,
  type HostDispatchObservation,
  type HostToolDispatchPort,
} from '../effects/tool-dispatch.js'
import type { SeamRuntime } from '../effects/wrap.js'
import type { InvariantRegistry } from '../invariants/registry.js'
// A type-only import, erased at compile time, so it is not a runtime cycle back to the kernel.
import type { CoreDiagName } from '../kernel.js'
import { scanAll, scanPages } from '../log/scan-pages.js'
import type { SessionLogImpl, Timers } from '../log/session-log.js'
import { SCAN_PAGE_MAX, type ScanQuery } from '../log/storage.js'
import { runDeferred } from '../loop/default/deferred.js'
import { bindDefaultLoopPorts, defaultLoopFactory } from '../loop/default-driver.js'
import { createLoopContext, disposeLoopContext } from '../loop/ports.js'
import type {
  AuxiliaryVisionAssemblyInput,
  AuxiliaryVisionProductionAdmission,
} from '../orchestrator/auxiliary-vision-assembly.js'
import type { RequestMediaLimits } from '../orchestrator/request-media.js'
import type {
  RequestMediaArtifactReader,
  RequestMediaSurfaceLimits,
} from '../orchestrator/request-media-surface.js'
import { type ChildTrace, ChildTraceCache, embedChildTraces } from '../project/child-trace-cache.js'
import { exportRlaf, type RlafDump, type RlafRange } from '../project/rlaf.js'
import type { SurfaceCache, SurfaceNode } from '../project/surface.js'
import { attachChildTraces, collectSubagentKeys, subagentOwners, type TraceOwners } from '../project/trace.js'
import { turnsForNodes } from '../project/turns.js'
import {
  boundedTimelinePage,
  type CoreUIHistoryPage,
  type CoreUIOpeningResult,
  type CoreUIProjectionUpdate,
  type CoreUITimeline,
  projectUI,
  turnCharge,
  type UIOptions,
  type UIProjectionCell,
} from '../project/ui.js'
import { contextTokensAtCut, projectUsage } from '../project/usage.js'
import type { Inbox, InboxItem } from '../reduce/shapes.js'
import { type EffectTree, effectTree } from '../reduce/state.js'
import { currentOp, type StateTracker } from '../reduce/tracker.js'
import { ResourceRegistry } from '../registry/resources.js'
import type { RegistrySnapshot, ToolRegistry, ToolSource } from '../registry/tools.js'
import type { PromptSection } from '../request/contribute.js'
import type { ContractRef, DeriveOutput, RequestHeaderData } from '../request/derive.js'
import { createEnvelopeCache, type EnvelopeCache } from '../request/envelope-cache.js'
import { type EnvelopeEpochs, nonceFor, recordHeader } from '../request/envelope-epochs.js'
import type { RequestBody as MintedRequestBody } from '../request/mint.js'
import { validateUserMessageImages } from '../request/user-message-images.js'
import type {
  CurrentRuntimeLookup,
  RuntimePromptPreload,
  RuntimePromptPreloader,
} from '../runtime/current.js'
import { type Clock, CoreError, type Event, type EventInput, type IdMinter, type Seq } from '../types.js'
import { expireApprovals, resumeApproval } from './approval-callback.js'
import { restoreSessionGrants } from './approval-grants.js'
import { runCompaction } from './compaction.js'
import { type AbortResult, abortSession, closeTurn, finishAborted } from './control.js'
import { sysEvent } from './events.js'
import { appendExtensionEvent, prepareExtensionEvent } from './ext-events.js'
import { checkpointRoutine, contextWindowFor } from './gate.js'
import {
  budgetOverrideEvent,
  claimFrom,
  type EnqueueMsg,
  INBOX_BUDGET_EVENT,
  type InboxBudgetOverride,
  inboxEvent,
  TRIGGER,
  TURN_BUDGET_EVENT,
  type TurnBudgetOverride,
} from './inbox.js'
import { discloseTools, resolveModel, runInference } from './inference.js'
import { resolvedModelInput, supportsComputerUse, toolNamesForModel, toolsForModel } from './model-tools.js'
import { newOpState, type OpStateObj, opMark, withPhase } from './op-state.js'
import { continueParked } from './parked.js'
import type { PresetView } from './preset.js'
import { type PreviewDelta, PreviewHub, type PreviewSnapshot } from './preview.js'
import { type CoreOpName, invokeTool, runCoreReplacement, setModel, setPreset } from './reentry.js'
import { type ResumeMode, type ResumeReport, resumeSession } from './resume.js'
import { runToolsPhase } from './tools.js'

type OperationCommon = {
  name: string
  order?: number
  replay: 'safe' | 'never'
  applicable(ctx: OpContext): Promise<'applied' | 'skip' | 'not-applicable'>
  /** Additive-slot entry point retained for existing package/host operation factories. */
  run(ctx: OpContext): Promise<OperationEffectResult>
  contribute?(ctx: OpContext): {
    tools?: string[]
    promptSections?: PromptSection[]
    runtimeContext?: Record<string, unknown>
  }
}

/**
 * One phase edge of a chain committed as a single append. `nextSeq` is the seq this step's first row
 * will be committed at, or the next step's first row when this step has none.
 */
export type ChainStep = {
  events: EventInput[]
  next: (cur: OpStateObj | null, nextSeq: Seq) => OpStateObj | null
}

export type OperationEffectResult = { effects?: EventInput[]; note?: string }

/** An ordinary additive operation; failures are diagnosed and the remaining slot stays runnable. */
export type SlotOperation = OperationCommon & {
  slot: 'core' | 'after-core' | 'before-inference'
}

export type InboxReplacementInput = { inbox: Inbox | undefined; target: 'next-step' }
export type InboxReplacementOutput = { action: 'none' } | { action: 'claim'; itemId: string }
export type BudgetReplacementInput = {
  nextStep: number
  /** null means no cumulative step ceiling; credit checks still apply. */
  maxSteps: number | null
  creditsUsed: number
  creditsCap: number | null
}
export type BudgetReplacementOutput =
  | { action: 'allow' }
  | {
      action: 'end'
      reason: Extract<TurnEndReason, 'budget' | 'max_steps' | 'blocked'>
      error?: { code: string; message: string }
      effects?: EventInput[]
    }
  | { action: 'delegated'; outcome: 'ok' | { reason: TurnEndReason } }
export type InferenceReplacementInput = {
  request: RequestBody
  options: { signal: AbortSignal; toolNames: string[] }
}
export type ApprovalReplacementInput = { request: ApprovalRequest; signal: AbortSignal }
export type ToolExecutionReplacementInput = { name: string; args: unknown; context: ToolContext }
export type StopGateReplacementInput = { turn: number; step: number; proposedReason: 'completed' }
export type StopGateReplacementOutput =
  | { action: 'continue'; note: string; effects?: EventInput[] }
  | {
      action: 'end'
      reason: Extract<TurnEndReason, 'completed' | 'blocked'>
      error?: { code: string; message: string }
      effects?: EventInput[]
    }
  | { action: 'delegated'; outcome: StepOutcome }

export type CoreReplacementInputMap = {
  Inbox: InboxReplacementInput
  Budget: BudgetReplacementInput
  Inference: InferenceReplacementInput
  Approval: ApprovalReplacementInput
  ToolExecution: ToolExecutionReplacementInput
  StopGate: StopGateReplacementInput
}
export type CoreReplacementOutputMap = {
  Inbox: InboxReplacementOutput
  Budget: BudgetReplacementOutput
  Inference: AsyncIterable<InferenceEvent>
  Approval: Verdict | ApprovalAnswer | Pending
  ToolExecution: ToolResult
  StopGate: StopGateReplacementOutput
}
export type ReplacementContext<K extends CoreOpName> = OpContext & {
  readonly segment: K
  readonly input: CoreReplacementInputMap[K]
  /** Runs the built-in segment once. A replacer must return this exact result if it delegates. */
  readonly next: () => Promise<CoreReplacementOutputMap[K]>
}
export type ReplacementOperation<K extends CoreOpName = CoreOpName> = OperationCommon & {
  slot: { replace: K }
  /** Typed replacement entry point; core never mistakes its result for additive `effects`. */
  replace(ctx: ReplacementContext<K>): Promise<CoreReplacementOutputMap[K]>
}

/**
 * A unit of work contributed by the assembly. Replacement operations use a closed, name-indexed
 * input/output contract; ordinary operations retain their existing additive contract unchanged.
 */
export type Operation = SlotOperation | { [K in CoreOpName]: ReplacementOperation<K> }[CoreOpName]
export type OpContext = {
  session: SessionImpl
  preset: PresetView
  state: OpStateObj | null
  /** Present for after-core operations, after the verifier has produced this turn's real result. */
  verifier?: VerifierVerdict
  snapshot: RegistrySnapshot
  signal: AbortSignal
  /**
   * The tool names core discloses on this request: the registry snapshot narrowed by the preset's
   * disclosure policy. It is the offer the model is about to be shown, which is not the same set as
   * `snapshot` — a deferred tool is registered and not offered — so an operation describing the
   * model's situation reads this rather than re-deriving it and getting a different answer.
   */
  disclosed: readonly string[]
  /** The slot, route and model id this request resolves to, before it is sent. */
  model: { slot: string; route: string; model: string }
}

/**
 * The in-process hook surface the step machine calls. It is a port, not a seam: the engine behind
 * it is assembled above core, and a session with no extensions runs against `noopHooks`.
 */
export type HookPort = {
  sessionStart?(p: { reason: 'new' | 'resume'; preset: string; cwd: string }): Promise<void>
  shutdown?(): Promise<void>
  resetTurn?(): void
  toolCall(p: {
    toolUseId: string
    name: string
    args: unknown
    meta: ToolMeta
    actor: Actor
    taint: boolean
    resolvedPolicy: ResolvedToolCallPolicy
    executionDomain: ExecutionDomain
    definitionFingerprint: string
    policyHash: string
  }): Promise<{ allow: true } | { allow: false; reason: string }>
  turnStopping(p: {
    turn: number
    step: number
    proposedReason: string
    verifier?: VerifierVerdict
  }): Promise<{ action: 'stop' } | { action: 'continue'; note: string }>
  context(sections: PromptSection[]): Promise<{ sections: PromptSection[]; additionalContext: string }>
  beforeRequest(out: DeriveOutput, slot: string, attempt: number): Promise<DeriveOutput>
  requestPatch?(payload: HookPayloadMap['before_request']): Promise<HookReturnMap['before_request']>
  beforeStep(p: { turn: number; step: number; depth: number }): Promise<{ block?: boolean; reason?: string }>
  toolResult?(p: HookPayloadMap['tool_result']): Promise<HookReturnMap['tool_result']>
  approvalRequest?(p: HookPayloadMap['approval_request']): Promise<HookReturnMap['approval_request']>
  requestError?(p: HookPayloadMap['request_error']): Promise<void>
  formatDeviation?(p: HookPayloadMap['format_deviation']): Promise<void>
  beforeCompact?(p: HookPayloadMap['before_compact']): Promise<BeforeCompactHookSelection>
  compact?(p: HookPayloadMap['compact']): Promise<void>
  subagentStart?(p: HookPayloadMap['subagent_start']): Promise<void>
  subagentEnd?(p: HookPayloadMap['subagent_end']): Promise<void>
}
export type BeforeCompactHookSelection =
  | Readonly<{ kind: 'unhandled' }>
  | Readonly<{ kind: 'handled'; plan: HookReturnMap['before_compact'] }>
export const noopHooks: HookPort = {
  toolCall: async () => ({ allow: true }),
  turnStopping: async () => ({ action: 'stop' }),
  context: async (s) => ({ sections: s, additionalContext: '' }),
  beforeRequest: async (o) => o,
  beforeStep: async () => ({}),
}

export type CompactionPort = {
  /** Absent is treated as false so older policy-only adapters cannot accidentally disclose a stub. */
  readonly runnable?: boolean
  /** Whether threshold compaction is held back this turn because the summary route failed outright. */
  suspended?(turn: number): boolean
  shouldCompact(p: {
    contextTokens: number
    contextWindow: number
    reserveTokens: number
    /**
     * The most recent inference's cache-read and input token counts, when known. Absent rather
     * than zeroed when there is nothing to report yet, so an implementation can tell "no signal"
     * from "a real zero-hit request" instead of reading both as equally cold.
     */
    cache?: { cacheRead: number; input: number }
  }): boolean
  onOverflow(): 'compaction' | 'failure'
}
export const noCompaction: CompactionPort = {
  runnable: false,
  shouldCompact: () => false,
  onOverflow: () => 'failure',
}

export type StepOutcome = LoopStepOutcome
export type TurnEndReason =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'parked'
  | 'blocked'
  | 'budget'
  | 'max_steps'
  | 'interrupted'
export type TurnOutcome = { reason: TurnEndReason; lastSeq: Seq; error?: { code: string; message: string } }

export type SessionDeps = {
  toolRuntimes?: ToolRuntimeRegistryPort
  toolPolicies?: ToolPolicyRegistryPort
  loopEvents?: LoopEventRegistryPort
  log: SessionLogImpl
  tracker: StateTracker
  surface: SurfaceCache
  ui: UIProjectionCell
  lane: string
  runtime: SeamRuntime
  provider: Provider
  loopFactory?: LoopFactory
  loopResume?: boolean
  withModelSnapshot?: <T>(operation: () => Promise<T>) => Promise<T>
  /**
   * Trusted host boundary for a conservative total-input-token bound when a wire request contains
   * images and the provider cannot count it. Implementations must account for the complete wire,
   * including every user-inline image, and return null unless any persisted media manifest can be
   * aligned exactly with those bytes. Core intentionally supplies no guessed image formula.
   */
  imageInputTokenFallback?: (input: {
    wire: RequestBody
    media?: RequestMediaHeader
    imageCount: number
    signal: AbortSignal
  }) => Promise<{ tokens: number; imageCount: number } | null> | { tokens: number; imageCount: number } | null
  /** Trusted Core media composition. Omission preserves the legacy text-placeholder path. */
  requestMedia?: Readonly<{
    readArtifact: RequestMediaArtifactReader
    surfaceLimits: RequestMediaSurfaceLimits
    mediaLimits: RequestMediaLimits
    auxiliaryVision?: Readonly<{
      productionAdmission?: AuxiliaryVisionProductionAdmission
      timeoutMs: AuxiliaryVisionAssemblyInput['timeoutMs']
      imageLimits: AuxiliaryVisionAssemblyInput['imageLimits']
      maxOutputTokens: number
      transformImage?: AuxiliaryVisionAssemblyInput['transformImage']
    }>
  }>
  registry: ToolRegistry
  /** Legacy fixed resource table used when Host does not supply a current-generation lookup. */
  resources?: ResourceRegistry
  /** Host-owned current generation lookup. Omission preserves the fixed-registry behavior. */
  currentRuntime?: CurrentRuntimeLookup
  sessionOverlay?: import('../runtime/overlay.js').SessionOverlayPort
  operations: Operation[]
  preset: PresetView
  contract: ContractRef
  contractForModel?: (target: { route: string; model: string }) => ContractRef
  children: ChildrenFactory
  /** Safe authority data; raw workspace runtime capabilities are consumed before Session publish. */
  workspaceIdentity?: import('../workspace/runtime.js').WorkspaceSessionIdentity
  /** Sole invocation lease owner for workspace-bound effects. */
  workspaceInvocation?: import('../workspace/runtime.js').WorkspaceInvocationPort
  /** Host publication admission used before every workspace invocation acquire. */
  workspacePublication?: import('../workspace/runtime.js').WorkspacePublicationDispatch
  /** The sole workspace close delegate retained by this session. */
  workspaceLease?: import('../workspace/runtime.js').SessionWorkspaceLifecycle
  /** Host-owned reservation port inherited by default child factories. */
  childWorkspaceRuntime?: import('../workspace/runtime.js').ChildWorkspaceRuntimePort
  ids: IdMinter
  clock: Clock
  actor: Actor
  resolvedProfileHash: string | null
  /** Carried into a new session/start only; a reopened ledger keeps the one it has. */
  imported?: SessionStart['imported']
  cwd: string
  netFetch: ToolContextDeps['netFetch']
  publicFetch?: ToolContextDeps['publicFetch']
  /** Trusted resolved profile value. Omission preserves the safe manual default. */
  approvalMode?: ApprovalMode
  /** Host-private attestation boundary for host-computer-use dispatches. */
  hostToolDispatch?: HostToolDispatchPort
  logger: Logger
  timers?: Timers
  hooks?: HookPort
  compaction?: CompactionPort
  /** Host-private request contribution; never exposed through extension hook payloads. */
  runtimePromptPreloader?: RuntimePromptPreloader
  agnesVersion?: string
  /**
   * Shared across every session the owning Kernel assembles; `@agnes/core`'s own checks are always
   * registered against it (see `Kernel`'s constructor). Not read anywhere in this file yet: wiring
   * the step machine itself to run invariant checks is later work, not part of what this task builds.
   */
  invariants?: InvariantRegistry
  /**
   * The Operation, if any, standing in for each of core's own named step-machine segments
   * (`CORE_OPS`). Populated once by `Kernel.session()` via `replacementFor`; each owning boundary in
   * gate/inference/tools dispatches its typed input/output through this table. Keeping the map on the
   * session makes replacement ownership immutable for the life of a writer lease.
   */
  segments?: Partial<{ [K in CoreOpName]: ReplacementOperation<K> | undefined }>
  /** Shared Kernel coordination port for safe reconciliation boundaries. */
  quiet?: QuietGate
  /** Root-session coordination identity; descendants inherit their parent's group. */
  quietGroup?: string
}

export type QuietGate = {
  enter(groupKey: string): Promise<void> | void
  leave(groupKey: string): void
  yieldPoint(kind: 'step' | 'turn', groupKey: string): Promise<void>
}

/** What one turn holds in memory. It is lost on a kill; everything durable is on the ledger. */
export type TurnMemory = {
  snapshot: RegistrySnapshot
  /** Context-hook output is frozen for identical assembly inputs within this turn. */
  prefix?: { key: string; sections: PromptSection[]; additionalContext: string }
  /** A null result means this turn already tried the Host-owned Skill preloader. */
  preload?: RuntimePromptPreload | null
  nonce: string
  /** Prefix of the most recent primary request after all request hooks have run. */
  lastPrefix?: Pick<MintedRequestBody, 'sections' | 'tools' | 'model' | 'samplingParams'>
  lastHeader: RequestHeaderData | null
  lastHeaderSeq: Seq | null
  ordinal: number
  ledgerFailed: boolean
  compactionRequested: string | null | false
  budgetCap?: number
  /** Extension rows counted toward this turn's quota so far, through `countedTo`. */
  extEvents?: { triggerSeq: Seq; countedTo: Seq; count: number }
}

const DEFAULT_TIMERS: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as number),
}

const encoder = new TextEncoder()

/**
 * Web turns with child trees embedded under the per-turn budget, each built at most once: paging
 * measures a turn by its embedded form, and the page returns that same copy.
 */
function webTurns(owners: TraceOwners, traces: ReadonlyMap<string, ChildTrace | undefined>) {
  const built = new Map<string, { turn: UITurn; bytes: number }>()
  const build = (turn: UITurn) => {
    let entry = built.get(turn.id)
    if (!entry) {
      const copy = structuredClone(turn)
      embedChildTraces(copy, owners, traces)
      entry = { turn: copy, bytes: encoder.encode(JSON.stringify(copy)).byteLength }
      built.set(turn.id, entry)
    }
    return entry
  }
  return {
    bytes: (turn: UITurn) => build(turn).bytes,
    take: (turn: UITurn) => build(turn).turn,
  }
}

export class SessionImpl {
  readonly d: SessionDeps
  readonly loop: LoopSelection
  private loopDriver!: LoopDriver
  private loopContext?: LoopContext
  private fallbackHooks: HookPort
  private readonly fallbackResources: ResourceRegistry
  compaction: CompactionPort
  preset: PresetView
  yolo = false
  turn: TurnMemory | null = null
  // run/step/resume calls in progress, and the resume they wait behind. `turn` and `op()` cannot say
  // this: both are set while a crashed turn waits to be continued, with nothing running.
  private activeOps = 0
  private resuming: Promise<unknown> | undefined
  private running: Promise<TurnOutcome> | undefined
  // The error the last turn/end row carried, for run() to hand back with its outcome. Phases report
  // only a reason; the row is the one place the failure is written, so this repeats it verbatim.
  private turnEndError: { code: string; message: string } | undefined
  readonly effects: EffectRuntime
  private readonly executePermits = new ExecutePermitRegistry()
  private readonly executePermitOwner = Object.freeze({})
  private readonly nestedToolScheduler = new NestedToolScheduler()
  private childTraceCache: ChildTraceCache | undefined
  private projectionTail: Promise<void> = Promise.resolve()
  /**
   * The grants an approver gave for the whole session rather than for one call. It lives on the
   * session, not on the turn: a grant rebuilt by `freshTurn` is an allowed-turn grant wearing an
   * allowed-session name, and every later turn would ask the human the same question again.
   * A fresh instance rebuilds validated session grants from approval and call records before use.
   */
  readonly sessionAllows = new Set<string>()
  readonly preview = new PreviewHub()
  /** Wrapping memo is optional; the durable header epochs determine historical envelope ids. */
  readonly envelopeCache: EnvelopeCache = createEnvelopeCache()
  readonly envelopeEpochs: EnvelopeEpochs = []
  private envelopeEpochsReady: Promise<void> | undefined
  async ensureEnvelopeEpochs(): Promise<void> {
    if (!this.envelopeEpochsReady) {
      this.envelopeEpochsReady = (async () => {
        if (this.lastSeq < 1) return
        for await (const page of scanPages((query) => this.d.log.scan(query), {
          fromSeq: 1,
          toSeq: this.lastSeq,
          type: 'request/header',
          lane: this.lane,
        })) {
          for (const row of page) {
            const nonce = (row.data as { envelopeNonce?: unknown }).envelopeNonce
            if (typeof nonce !== 'string')
              throw new CoreError('E_RELATION', 'request header lacks envelope nonce')
            recordHeader(this.envelopeEpochs, row.seq, nonce)
          }
        }
      })()
    }
    await this.envelopeEpochsReady
  }
  envelopeNonceFor(nodeSeq: number): string | undefined {
    return nonceFor(this.envelopeEpochs, nodeSeq)
  }
  recordEnvelopeHeader(headerSeq: number, nonce: string): void {
    recordHeader(this.envelopeEpochs, headerSeq, nonce)
  }
  private grantsRestored = false
  private async restoreGrants(): Promise<void> {
    if (this.grantsRestored) return
    await restoreSessionGrants(this)
    this.grantsRestored = true
  }
  private lock: Promise<void> = Promise.resolve()
  /**
   * The cancellation scope of the work in flight, which is the scope of one `run()`. `run()`
   * replaces it, because "stop this turn" and "this session is over" are different statements and
   * only the second is permanent: one controller serving both is aborted by a single Ctrl-C and
   * then reports `aborted` to every phase of every later run, so the session goes on accepting
   * prompts it can never answer. Replacing it loses no cancellation — `abort()` records the request
   * on the counter before it pulls the signal, and `step()` ends a turn marked cancelled whichever
   * controller is current.
   */
  ac = new AbortController()
  /** `close()` is final, so a closed session must not be handed a fresh signal by the next `run()`. */
  private closing = false

  get closingOrClosed(): boolean {
    return this.closing
  }

  constructor(deps: SessionDeps) {
    this.d = deps
    this.loopEvents = deps.loopEvents ?? new LoopEventRegistry()
    this.toolRuntimes = deps.toolRuntimes ?? new ToolRuntimeRegistry()
    this.toolPolicies = deps.toolPolicies ?? new ToolPolicyRegistry()
    this.loop = Object.freeze({
      id: (deps.loopFactory ?? defaultLoopFactory).id,
      version: (deps.loopFactory ?? defaultLoopFactory).version,
    })
    this.fallbackHooks = deps.hooks ?? noopHooks
    this.fallbackResources = deps.resources ?? new ResourceRegistry()
    this.compaction = deps.compaction ?? noCompaction
    this.preset = deps.preset
    this.effects = new EffectRuntime({
      ev: (type, data) => this.ev(type, data),
      clock: deps.clock,
      effectId: () => deps.ids.effectId(),
    })
  }

  /** Resolve the published hook port at the call boundary; assignment only updates legacy fallback. */
  get hooks(): HookPort {
    return this.d.currentRuntime?.current(this.key)?.hooks ?? this.fallbackHooks
  }

  set hooks(hooks: HookPort) {
    this.fallbackHooks = hooks
  }

  /** Current tool registry used only when taking a new lookup/snapshot. */
  currentTools(): ToolRegistry {
    return this.d.currentRuntime?.current(this.key)?.tools ?? this.d.registry
  }

  /** Current resource registry used by lifecycle discovery and Host adapters. */
  currentResources(): ResourceRegistry {
    return this.d.currentRuntime?.current(this.key)?.resources ?? this.fallbackResources
  }

  /** Current Host-private preloader, resolved immediately before request assembly. */
  currentRuntimePromptPreloader(): RuntimePromptPreloader | undefined {
    if (!this.d.currentRuntime) return this.d.runtimePromptPreloader
    const runtime = this.d.currentRuntime.current(this.key)
    return runtime ? runtime.runtimePromptPreloader : this.d.runtimePromptPreloader
  }

  /** A system row on this session's lane, which is the shape of nearly everything core writes. */
  ev(type: string, data: unknown, extra: Partial<EventInput> = {}): EventInput {
    return sysEvent({ actor: this.d.actor, lane: this.lane }, type, data, extra)
  }

  get key(): string {
    return this.d.log.key
  }
  get writerRunId(): string {
    return this.d.log.writerRunId
  }
  get lastSeq(): Seq {
    return this.d.log.lastSeq
  }
  /** Every committed batch, in commit order, as it is committed. */
  onAppended(fn: (events: Event[]) => void): () => void {
    return this.d.log.observeCommitted('*', fn)
  }
  /** Streamed model text as it arrives. It is never a ledger row and carries no seq. */
  onPreview(fn: (p: PreviewDelta) => void): () => void {
    return this.preview.on(fn)
  }
  /** The text every inference still in flight has streamed so far. */
  previewSnapshot(): PreviewSnapshot[] {
    return this.preview.snapshot()
  }
  /** Called once if this session's log seals itself; see SessionLogImpl.onFault. */
  onFault(fn: (e: CoreError) => void): () => void {
    return this.d.log.onFault(fn)
  }
  get lane(): string {
    return this.d.lane
  }
  get generationDepth(): number {
    const start = this.state.session as { delegation?: { generationDepth?: number } } | null
    return start?.delegation?.generationDepth ?? 0
  }
  get state() {
    return this.d.tracker.state
  }

  readonly loopEvents: LoopEventRegistryPort
  private readonly toolRuntimes: ToolRuntimeRegistryPort
  private readonly toolPolicies: ToolPolicyRegistryPort
  private readonly runtimeInstances: Array<{
    provider: ToolRuntimeProvider
    maxParallel: number
    runtime: ToolRuntime
  }> = []

  async toolRuntime(): Promise<ToolRuntime> {
    const provider = this.toolRuntimes.resolve(this.preset.tools.runtime ?? 'default')
    const maxParallel = this.preset.tools.maxParallel ?? 4
    let instance = this.runtimeInstances.find(
      (entry) => entry.provider === provider && entry.maxParallel === maxParallel,
    )
    if (!instance) {
      instance = { provider, maxParallel, runtime: provider.create({ maxParallel }) }
      this.runtimeInstances.push(instance)
    }
    // Keep previous instances until close: an in-flight batch may still own one after a preset switch.
    return instance.runtime
  }
  toolPolicy() {
    return this.toolPolicies.resolve(this.preset.approval.policy ?? 'default')
  }

  private initialModelSettingsRestored = false

  private async initializeLoop(resumed = false): Promise<void> {
    if (this.loopDriver) return
    this.toolPolicy()
    await this.toolRuntime()
    const ctx = await createLoopContext(this)
    this.loopContext = ctx
    bindDefaultLoopPorts(ctx, {
      session: this,
      continueParked: () => continueParked(this),
      finishAborted: () => finishAborted(this),
      checkpoint: () => checkpointRoutine(this),
    })
    const factory = this.d.loopFactory ?? defaultLoopFactory
    const checkpoint =
      ctx.checkpoints.read() ??
      (resumed && factory === defaultLoopFactory ? factory.codec.encode(this.op()) : null)
    if (resumed && !checkpoint) throw new Error('Pinned loop checkpoint is missing')
    if (checkpoint) factory.codec.decode(checkpoint)
    this.loopDriver = resumed && checkpoint ? factory.resume(ctx, checkpoint) : factory.create(ctx)
    if (!resumed && factory !== defaultLoopFactory) await ctx.checkpoints.write(this.loopDriver.checkpoint())
  }

  /** Idempotent: a reopened ledger already carries its session/start and must not gain a second. */
  async start(): Promise<void> {
    if (this.state.session) {
      const pinned = this.state.session.loop ?? defaultLoopFactory
      if (pinned.id !== this.loop.id || pinned.version !== this.loop.version)
        throw new Error('Session loop does not match its persisted identity')
      if (!this.initialModelSettingsRestored)
        this.restoreInitialModelSettings(this.state.session.modelSettings)
      await this.restoreYolo()
      await this.initializeLoop(this.d.loopResume ?? true)
      return
    }
    const modelSettings: NonNullable<SessionStart['modelSettings']> = []
    let records: ModelRecord[] = []
    try {
      records = this.d.provider.models()
    } catch {
      // Match resolveModel's fallback when a provider cannot publish its catalogue.
    }
    for (const slot of Object.keys(this.preset.model.route)) {
      const target = resolveModel(this, slot)
      const record = records.find((m) => m.route === target.route && m.id === target.model)
      if (!record) continue
      const thinking = this.preset.model.thinking[slot] ?? record.defaultSettings?.thinking
      modelSettings.push({
        slot,
        ...target,
        settings: {
          ...(thinking === undefined ? {} : { thinking }),
          contextWindow:
            this.preset.model.contextWindow?.[slot] ??
            record.defaultSettings?.contextWindow ??
            record.contextWindow,
        },
      })
    }
    await this.d.log.append([
      // The one row that carries no lane: a session opens once, not once per lane.
      {
        type: 'session/start',
        origin: 'system',
        trust: 'trusted',
        actor: this.d.actor,
        data: {
          key: this.key,
          loop: { ...this.loop },
          resolvedProfileHash: this.d.resolvedProfileHash,
          preset: this.preset.name,
          agnesVersion: this.d.agnesVersion ?? '0.0.0',
          ...(modelSettings.length ? { modelSettings } : {}),
          ...(this.d.imported ? { imported: this.d.imported } : {}),
        },
      },
    ])
    this.restoreInitialModelSettings(modelSettings)
    await this.initializeLoop()
  }

  private restoreInitialModelSettings(models: SessionStart['modelSettings']): void {
    this.initialModelSettingsRestored = true
    if (!models) return
    const model = {
      ...this.preset.model,
      route: { ...this.preset.model.route },
      id: { ...this.preset.model.id },
      thinking: { ...this.preset.model.thinking },
      contextWindow: { ...this.preset.model.contextWindow },
    }
    for (const selection of models) {
      const slot = selection.slot
      model.route[slot] = selection.route
      model.id[slot] = selection.model
      model.thinking[slot] = selection.settings.thinking
      model.contextWindow[slot] = selection.settings.contextWindow
    }
    this.preset = { ...this.preset, model }
    this.d.runtime.preset = this.preset
  }

  /**
   * Rebuild the approval bypass only from the latest complete, owner-bound switch. Legacy and
   * malformed rows deliberately mean disabled: walking back to an older `true` row would turn a
   * corrupt or partially migrated revocation into an authorization grant.
   */
  private async restoreYolo(): Promise<void> {
    this.yolo = false
    try {
      const [row] = await this.d.log.scan({ type: 'x/core/yolo-switch', order: 'desc', limit: 1 })
      if (row?.origin !== 'system' || row.trust !== 'trusted' || row.lane !== this.lane) return
      const inspectedActor = inspectJsonData(row.actor, 16 * 1024)
      if (!inspectedActor.ok) return
      const checkedActor = validateActor(inspectedActor.value)
      if (!checkedActor.ok) return
      const inspected = inspectJsonData(row.data, 16 * 1024)
      if (!inspected.ok || !inspected.value || Array.isArray(inspected.value)) return
      const data = inspected.value as Record<string, unknown>
      if (
        Reflect.ownKeys(data).length !== 7 ||
        data.version !== 1 ||
        typeof data.to !== 'boolean' ||
        data.sessionKey !== this.key ||
        data.lane !== this.lane ||
        data.profileHash !== this.d.resolvedProfileHash ||
        data.operatorId !== checkedActor.value.id
      )
        return
      const owner = data.sessionOwner
      if (
        !owner ||
        typeof owner !== 'object' ||
        Array.isArray(owner) ||
        Reflect.ownKeys(owner).length !== 2 ||
        (owner as Record<string, unknown>).id !== this.d.actor.id ||
        (owner as Record<string, unknown>).org !== this.d.actor.org
      )
        return
      this.yolo = data.to
    } catch {
      // A bypass is never required to open a session. Unreadable/corrupt history stays disabled.
      this.yolo = false
    }
  }

  op(): OpStateObj | null {
    return currentOp(this.d.log, this.lane)
  }
  opSeq(): Seq | null {
    return this.d.log.registerRow('op.state', this.lane)?.seq ?? null
  }

  /**
   * Whether untrusted content has reached the turn currently open on this lane, read from the fold
   * rather than from the program counter. The counter carries a copy, and a copy is written one
   * transaction behind the row that taints — reading the copy at the moment an approval is decided
   * therefore fails open exactly once per turn, which is the once that matters.
   *
   * False outside an open turn: the fold keeps the last turn's answer after `turn/end`, and a turn
   * that has finished cannot taint the next one.
   */
  laneTaint(): boolean {
    return this.state.openTurn.has(this.lane) && this.state.taint.get(this.lane) === true
  }

  /** Serializes work against every other writer on this session, transitions and inbox alike. */
  appendExtensionEvent(type: string, data: unknown, meta: ToolSource): Promise<Seq> {
    const event = prepareExtensionEvent(type, data, meta)
    return this.locked(() => appendExtensionEvent(this, event))
  }

  /**
   * Not `private`: Task 32a's `setModel` lives in `reentry.ts` as a standalone function (the same
   * shape `setPreset` already takes), not as a method on this class, so it needs this lock from
   * outside the class body. Still excluded from `index.ts`'s public export surface.
   */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn, fn)
    this.lock = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }

  /**
   * A phase edge: the work of the phase and the new program counter land in one append, guarded by
   * a compare-and-set on the op.state cell the phase was read from. Two writers cannot both advance
   * from the same phase, and a crash between them is impossible because there is no between.
   *
   * An event factory runs inside the commit lock with the batch start sequence, so related
   * evidence and inbox changes can be built without racing an enqueue.
   *
   * The CAS seq is captured **before** the queue, not inside it: read inside, it names whatever the
   * cell holds once the lock is free, so a transition built on a phase another transition has
   * already superseded would be written with a fresh, matching seq and would succeed. Read outside,
   * it names the cell the caller actually computed `next` from, and an in-process lost update is
   * refused with `E_CAS` the same way an out-of-process one is.
   *
   * A caller that cannot compute `next` up front — a member of a concurrent batch, which must
   * derive its patch from whatever the lock holder finds — passes a function instead. That form is
   * checked against the cell it reads inside the lock, because that is the cell it read. Its second
   * argument is the sequence number the first row of this batch will be committed at, which is what
   * the two sites that used to predict their own seqs need and could not safely guess outside.
   */
  transition(
    events: EventInput[] | ((nextSeq: Seq) => EventInput[]),
    next: OpStateObj | null | ((cur: OpStateObj | null, nextSeq: Seq) => OpStateObj | null),
    opts: { refineCaller?: boolean } = {},
  ): Promise<Seq[]> {
    const expected = this.opSeq()
    const step: ChainStep = {
      events: typeof events === 'function' ? [] : events,
      next: (cur, nextSeq) => {
        if (typeof events === 'function') step.events.push(...events(nextSeq))
        return typeof next === 'function' ? next(cur, nextSeq) : next
      },
    }
    // No extra promise hop: the caller resumes on the same tick it always has.
    return this.commitChain([step], typeof next === 'function' ? undefined : expected, opts, (seqs) => seqs)
  }

  /**
   * Several phase edges committed as one append: each step's `next` is computed under the lock from
   * the value the step before it produced, the rows of every step are committed together, and only
   * the last step's value is written to the cell. The values in between exist only inside the lock,
   * so a caller may chain steps only when nothing outside the process happens between them. Checked
   * like the function form of `transition`. Returns the seqs of each step's own rows; the op-mark a
   * chain with no rows at all writes belongs to its last step.
   */
  transitionChain(steps: ChainStep[], opts: { refineCaller?: boolean } = {}): Promise<Seq[][]> {
    return this.commitChain(steps, undefined, opts, (seqs) => {
      let at = 0
      return steps.map((step, index) => {
        const from = at
        at += step.events.length
        return index === steps.length - 1 ? seqs.slice(from) : seqs.slice(from, at)
      })
    })
  }

  /** `expected` is the cell seq read before the queue; undefined reads it inside the lock. */
  private commitChain<T>(
    steps: ChainStep[],
    expected: Seq | null | undefined,
    opts: { refineCaller?: boolean },
    receipt: (seqs: Seq[]) => T,
  ): Promise<T> {
    if (steps.length === 0) throw new CoreError('E_RELATION', 'a transition chain needs at least one step')
    return this.locked(async () => {
      const seq = expected === undefined ? this.opSeq() : expected
      const first = this.op()
      // Taint is carried onto the counter here rather than at each phase edge: it is derived from
      // the fold, and only the lock holder knows which rows have been folded into it. It cannot
      // leak into a turn that has not opened yet, because `laneTaint` reads false while the lane
      // has no open turn — and acceptInput's `turn/start` is still unwritten at this point. Nothing
      // is folded between the steps of a chain, so every step reads the same answer.
      const taint = this.laneTaint()
      let state = first
      const rows: EventInput[] = []
      for (const step of steps) {
        const computed = step.next(state, (this.lastSeq + 1 + rows.length) as Seq)
        state = computed && taint ? { ...computed, taint: true } : computed
        rows.push(...step.events)
      }
      // The counter is a register cell committed with the batch. A commit with no row of its own
      // still writes one, so the head, the cell's seq and the CAS all move on together.
      if (rows.length === 0) rows.push(opMark(first, state, this.lane, this.d.actor))
      const r = await this.d.log.append(rows, {
        expectedRegisterSeq: { register: 'op.state', key: this.lane, seq },
        opState: { lane: this.lane, data: state },
        ...opts,
      })
      return receipt(r.seqs)
    })
  }

  async endTurn(
    reason: TurnEndReason,
    extra: {
      error?: { code: string; message: string }
      lastAssistantSeq?: Seq | null
      events?: EventInput[] | ((nextSeq: Seq) => EventInput[])
    } = {},
  ): Promise<Seq> {
    const turnNumber = this.op()?.meta.turn ?? 0
    const last = extra.lastAssistantSeq ?? this.op()?.latestAssistantSeq ?? null
    const events = extra.events
    const end = this.ev('turn/end', {
      reason,
      lastAssistantSeq: last,
      ...(extra.error ? { error: extra.error } : {}),
    })
    const seqs = await this.transition(
      typeof events === 'function' ? (seq) => [...events(seq), end] : [...(events ?? []), end],
      null,
    )
    this.turn = null
    this.turnEndError = extra.error
    // Observer failure cannot undo a committed turn ending.
    await this.loopEvents
      .dispatch(
        'turn_end',
        { turn: turnNumber, reason },
        loopEventContext(this, new AbortController().signal),
      )
      .catch((error) => this.d.logger.warn('turn_end observer failed', { message: String(error) }))
    return seqs[seqs.length - 1] as Seq
  }

  /** Diagnostics are advisory rows: they are ignorable, and a failure to write one is swallowed. */
  diag(name: CoreDiagName, data: unknown): Promise<unknown> {
    return this.d.log.append([this.ev(`x/core/${name}`, data, { ignorable: true })]).catch(() => undefined)
  }

  /**
   * Under the same lock as the phase edges. It is a public entry point a channel adapter calls from
   * another task, and it appends to a register cell it read a moment earlier: outside the lock, two
   * enqueues drop one item, and one landing mid-transition shifts the sequence numbers the turn's
   * anchor and its tool arguments are addressed by.
   */
  enqueue(target: 'next-turn' | 'next-step', msg: EnqueueMsg): Promise<Seq> {
    let content: ContentBlock[]
    try {
      content = structuredClone(msg.content)
      validateUserMessageImages(content)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.locked(async () => {
      if (msg.budget !== undefined) {
        if (target !== 'next-turn')
          throw new CoreError('E_ENVELOPE', 'a per-turn budget override requires next-turn input')
        if (!Number.isFinite(msg.budget) || msg.budget < 0)
          throw new CoreError('E_ENVELOPE', 'a per-turn budget override must be a finite non-negative number')
      }
      if (content.some((block) => block.type === 'image')) {
        const target = resolveModel(this, 'primary')
        const model = this.d.provider.models().find((m) => m.route === target.route && m.id === target.model)
        const error = modelImageInputError(model, [{ content }])
        if (error) throw new CoreError('E_ENVELOPE', error)
      }
      const cur = (this.latest('inbox') as Inbox | undefined) ?? { items: [] }
      const item: InboxItem = {
        itemId: this.d.ids.requestId(),
        target,
        content,
        actor: msg.actor,
        enqueuedAt: new Date(this.d.clock()).toISOString(),
        ...(msg.commandId ? { commandId: msg.commandId } : {}),
        ...(msg.admissionId ? { admissionId: msg.admissionId } : {}),
        kind: msg.kind ?? (target === 'next-turn' ? 'prompt' : 'steer'),
        ...(msg.titleLocale ? { titleLocale: msg.titleLocale } : {}),
        trust: msg.trust ?? 'trusted',
      }
      const nextInbox = inboxEvent(this.lane, this.d.actor, { items: [...cur.items, item] })
      if (encoder.encode(JSON.stringify(nextInbox)).byteLength > MAX_FRAME_BYTES - 4096)
        throw new CoreError(
          'E_ENVELOPE',
          'Queued inputs are too large. Wait for a pending message to finish or remove one before sending more attachments.',
        )
      const r = await this.d.log.append([
        nextInbox,
        ...(msg.budget !== undefined
          ? [
              budgetOverrideEvent(INBOX_BUDGET_EVENT, this.d.actor, {
                itemId: item.itemId,
                creditsCap: msg.budget,
              }),
            ]
          : []),
      ])
      return r.firstSeq
    })
  }

  /** Remove only unclaimed next-turn input under the same lock as enqueue and acceptInput. */
  removeQueuedInput(itemId: string, by: Actor, admissionId: string): Promise<Seq> {
    return this.locked(async () => {
      const inbox = (this.latest('inbox') as Inbox | undefined) ?? { items: [] }
      if (!inbox.items.some((item) => item.itemId === itemId && item.target === 'next-turn'))
        throw new CoreError('E_RELATION', 'queued input is no longer pending', { itemId })
      const written = await this.d.log.append([
        inboxEvent(this.lane, this.d.actor, {
          items: inbox.items.filter((item) => item.itemId !== itemId),
        }),
        this.ev('x/core/queued-input-removed', { itemId, admissionId, by }, { ignorable: true }),
      ])
      return written.firstSeq
    })
  }

  /** Atomically prioritize existing input and cancel the current turn; wait for its drain before resuming. */
  async sendQueuedNow(itemId: string, by: Actor, admissionId: string): Promise<Seq> {
    let draining: Promise<TurnOutcome> | undefined
    const seq = await this.locked(async () => {
      const inbox = (this.latest('inbox') as Inbox | undefined) ?? { items: [] }
      const item = inbox.items.find((item) => item.itemId === itemId && item.target === 'next-turn')
      if (!item) throw new CoreError('E_RELATION', 'queued input is no longer pending', { itemId })
      const op = this.op()
      draining = this.running
      const written = await this.d.log.append(
        [
          inboxEvent(this.lane, this.d.actor, {
            items: [item, ...inbox.items.filter((candidate) => candidate.itemId !== itemId)],
          }),
          this.ev('x/core/queued-send-now', { itemId, admissionId }, { ignorable: true }),
        ],
        op
          ? {
              expectedRegisterSeq: { register: 'op.state', key: this.lane, seq: this.opSeq() },
              opState: {
                lane: this.lane,
                data: withPhase(op, op.phase, {
                  control: {
                    status: 'cancel_requested',
                    requestedAt: new Date(this.d.clock()).toISOString(),
                    by,
                  },
                }),
              },
            }
          : {},
      )
      this.ac.abort()
      return written.firstSeq
    })
    if (draining) await draining
    // A parked/recovered turn has no run promise; close its cancelled state before the new run.
    if (this.op()?.control.status === 'cancel_requested')
      await this.run({ until: 'turn-end', signal: new AbortController().signal })
    return seq
  }

  lastTurnNumber(): number {
    return this.state.lastTurn.get(this.lane) ?? 0
  }

  /**
   * Opens a turn from the first queued prompt. The claim, the message it becomes, the turn and the
   * program counter are one transaction: any subset of them on the ledger is a state the resume
   * path cannot read.
   */
  async acceptInput(): Promise<boolean> {
    if (this.op()) return false
    await this.restoreGrants()
    return this.locked(async () => {
      if (this.op()) return false
      const claimed = claimFrom(this.latest('inbox') as Inbox | undefined, 'next-turn')
      if (!claimed) return false
      const { item, rest } = claimed
      const turn = this.lastTurnNumber() + 1
      const budget = await this.inboxBudget(item.itemId)
      const triggerSeq = (this.lastSeq + 2) as Seq
      await this.d.log.append(
        [
          inboxEvent(this.lane, this.d.actor, rest),
          {
            type: 'user/message',
            origin: 'principal',
            // Whoever enqueued the item decided how far it is trusted; the accept path stamps what
            // it was told rather than inferring it from the actor's role.
            trust: item.trust ?? 'trusted',
            actor: item.actor,
            lane: this.lane,
            data: {
              content: item.content,
              kind: item.kind ?? 'prompt',
              ...(item.titleLocale ? { titleLocale: item.titleLocale } : {}),
            },
          },
          {
            type: 'turn/start',
            origin: 'system',
            trust: 'trusted',
            actor: this.d.actor,
            lane: this.lane,
            data: { turn, trigger: TRIGGER[item.kind ?? 'prompt'] },
          },
          ...(budget !== undefined
            ? [
                budgetOverrideEvent(TURN_BUDGET_EVENT, this.d.actor, {
                  turn,
                  itemId: item.itemId,
                  creditsCap: budget,
                }),
              ]
            : []),
        ],
        {
          expectedRegisterSeq: { register: 'op.state', key: this.lane, seq: this.opSeq() },
          opState: {
            lane: this.lane,
            data: newOpState(
              {
                turn,
                lane: this.lane,
                acceptedAt: new Date(this.d.clock()).toISOString(),
                triggerSeq,
                presetName: this.preset.name,
                profileHash: this.d.resolvedProfileHash,
                depthLimit: this.preset.depthLimit,
              },
              triggerSeq,
            ),
          },
        },
      )
      this.hooks.resetTurn?.()
      this.turn = this.freshTurn()
      if (budget !== undefined) this.turn.budgetCap = budget
      return true
    })
  }

  /**
   * Opens one ledger-bound manual-compaction turn without asking a model to call the compact Tool.
   * The command marker makes daemon journal recovery exact, while the phase itself is the same
   * CompactionRunner path used by requested Tool calls, threshold checks and overflow recovery.
   */
  async requestCompaction(input: { actor: Actor; admissionId: string; instructions?: string }): Promise<Seq> {
    if (this.op()) throw new CoreError('E_RELATION', 'manual compaction requires an idle session')
    if (!input.admissionId) throw new CoreError('E_ENVELOPE', 'manual compaction admissionId is required')
    if (input.instructions !== undefined && input.instructions.length > 4096)
      throw new CoreError('E_ENVELOPE', 'manual compaction instructions are too long')
    await this.restoreGrants()
    const turn = this.lastTurnNumber() + 1
    const command = input.instructions ? `/compact ${input.instructions}` : '/compact'
    const seqs = await this.transition(
      [
        this.ev(
          'user/message',
          { content: [{ type: 'text', text: command }], kind: 'steer' },
          { origin: 'principal', trust: 'trusted', actor: input.actor },
        ),
        this.ev('turn/start', {
          turn,
          trigger: 'steer',
        }),
        this.ev(
          'x/core/manual-compaction',
          {
            admissionId: input.admissionId,
            ...(input.instructions ? { instructions: input.instructions } : {}),
          },
          { ignorable: true },
        ),
      ],
      (_cur, nextSeq) => {
        const checkpoint = {
          kind: 'checkpoint' as const,
          continuation: 'may_finish' as const,
          triggerSeq: nextSeq,
        }
        return withPhase(
          newOpState(
            {
              turn,
              lane: this.lane,
              acceptedAt: new Date(this.d.clock()).toISOString(),
              triggerSeq: nextSeq,
              presetName: this.preset.name,
              profileHash: this.d.resolvedProfileHash,
              depthLimit: this.preset.depthLimit,
            },
            nextSeq,
          ),
          {
            kind: 'compaction',
            reason: 'requested',
            resumeAfter: checkpoint,
            ...(input.instructions ? { plan: { customInstructions: input.instructions } } : {}),
          },
        )
      },
    )
    this.hooks.resetTurn?.()
    this.turn = this.freshTurn()
    return seqs[2] as Seq
  }

  private async inboxBudget(itemId: string): Promise<number | undefined> {
    let found: number | undefined
    let toSeq: Seq | undefined
    for (;;) {
      const rows = await this.d.log.scan({
        type: INBOX_BUDGET_EVENT,
        order: 'desc',
        limit: SCAN_PAGE_MAX,
        ...(toSeq === undefined ? {} : { toSeq }),
      })
      for (const event of rows) {
        const data = event.data as Partial<InboxBudgetOverride> | null
        if (data?.itemId !== itemId) continue
        if (typeof data.creditsCap !== 'number' || !Number.isFinite(data.creditsCap) || data.creditsCap < 0)
          throw new CoreError('E_ENVELOPE', 'stored per-turn budget override is invalid')
        if (found !== undefined)
          throw new CoreError('E_RELATION', `duplicate budget override for inbox item ${itemId}`)
        found = data.creditsCap
      }
      if (rows.length < SCAN_PAGE_MAX) return found
      const oldest = rows.at(-1)
      if (!oldest || oldest.seq <= 1) return found
      toSeq = (oldest.seq - 1) as Seq
    }
  }

  private async rehydratedBudget(op: OpStateObj): Promise<number | undefined> {
    let found: number | undefined
    let fromSeq = op.meta.triggerSeq
    for (;;) {
      const rows = await this.d.log.scan({
        fromSeq,
        toSeq: this.lastSeq,
        type: TURN_BUDGET_EVENT,
        order: 'asc',
        limit: SCAN_PAGE_MAX,
      })
      for (const event of rows) {
        const data = event.data as Partial<TurnBudgetOverride> | null
        if (data?.turn !== op.meta.turn) continue
        if (
          typeof data.itemId !== 'string' ||
          typeof data.creditsCap !== 'number' ||
          !Number.isFinite(data.creditsCap) ||
          data.creditsCap < 0
        )
          throw new CoreError('E_ENVELOPE', 'stored turn budget override is invalid')
        if (found !== undefined)
          throw new CoreError('E_RELATION', `duplicate budget override for turn ${op.meta.turn}`)
        found = data.creditsCap
      }
      if (rows.length < SCAN_PAGE_MAX) return found
      const newest = rows.at(-1)
      if (!newest || newest.seq >= this.lastSeq) return found
      fromSeq = (newest.seq + 1) as Seq
    }
  }

  /**
   * `asOf` is the seq the tool registry is snapshotted at. A resumed turn passes its own start, not
   * the resume point: a tool registered while the turn was down was never disclosed to the model,
   * and a turn that can suddenly call one it was never shown is a turn whose request no longer
   * describes what it may do.
   */
  freshTurn(ordinal = 0, asOf: Seq = this.lastSeq): TurnMemory {
    return {
      snapshot: this.currentTools().snapshot(asOf),
      nonce: this.d.ids.nonce(),
      lastHeader: null,
      lastHeaderSeq: null,
      ordinal,
      ledgerFailed: false,
      compactionRequested: false,
    }
  }

  /** Effective request cap for the open turn. Recovery fills the in-memory value from the durable
   * turn marker; using an open turn before that recovery is refused instead of losing its cap. */
  turnBudgetCap(): number | null {
    const op = this.op()
    if (!op) return this.preset.budget.perRequestCap
    if (!this.turn) throw new CoreError('E_RELATION', 'open turn budget has not been rehydrated')
    return this.turn.budgetCap ?? this.preset.budget.perRequestCap
  }

  /**
   * The one canonical context for a core-segment replacement. Call sites add only their typed
   * segment input; model selection, disclosure and the turn snapshot stay identical everywhere.
   */
  operationContext(): OpContext {
    const target = resolveModel(this, 'primary')
    const computerUseAllowed = this.computerUseAllowed(target)
    const snapshot = this.turn?.snapshot ?? this.currentTools().snapshot(this.lastSeq)
    return {
      session: this,
      preset: this.preset,
      state: this.op(),
      snapshot: toolsForModel(snapshot, computerUseAllowed),
      signal: this.ac.signal,
      disclosed: toolNamesForModel(discloseTools(this), computerUseAllowed),
      model: { slot: 'primary', ...target },
    }
  }

  computerUseAllowed(target = resolveModel(this, 'primary')): boolean {
    return supportsComputerUse(resolvedModelInput(this.d.provider, target))
  }

  /** The verdict alone, for callers that have no use for the reason behind it. */
  async askApproval(request: ApprovalRequest, signal: AbortSignal): Promise<Verdict | Pending> {
    const answer = await this.askApprovalAnswer(request, signal)
    return isPending(answer) ? answer : answer.verdict
  }

  async askApprovalAnswer(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer | Pending> {
    const raw = this.d.segments?.Approval
      ? await runCoreReplacement(this, 'Approval', this.operationContext(), { request, signal }, () =>
          this.d.runtime.approvalAsk(request, signal),
        )
      : await this.d.runtime.approvalAsk(request, signal)
    // A replacement that answers outside the set is refused like a seam that does.
    return normalizeApproval(raw) ?? { verdict: 'rejected' }
  }

  async executeTool(
    name: string,
    args: unknown,
    context: ToolContext,
    started: { effectId: string; startSeq: Seq },
    builtin: () => Promise<ToolResult>,
    dispatch: { executionDomain: ExecutionDomain; attempt: ExecuteAttempt },
  ): Promise<HostDispatchObservation> {
    // This method is the sole external tool-dispatch choke point. The caller can only reach it with
    // the sequence returned by the append that durably wrote effect/intent; authority itself stays
    // process-local and is consumed before either the built-in or a replacement is entered.
    this.assertToolDispatchAvailable(dispatch.executionDomain)
    const runtime = await this.toolRuntime()
    const binding = { ...started, owner: this.executePermitOwner, attempt: dispatch.attempt }
    const permit = this.executePermits.issue(binding)
    this.executePermits.consume(permit, binding)
    return dispatchTool({
      name,
      args,
      context,
      executionDomain: dispatch.executionDomain,
      attempt: dispatch.attempt,
      runtime,
      concurrencySafe: this.turn?.snapshot.byName.get(name)?.meta.isConcurrencySafe === true,
      ...(this.d.hostToolDispatch ? { hostPort: this.d.hostToolDispatch } : {}),
      invoke: () => {
        if (!this.d.segments?.ToolExecution) return builtin()
        return runCoreReplacement(
          this,
          'ToolExecution',
          this.operationContext(),
          { name, args, context },
          builtin,
        )
      },
    })
  }

  /** Caller guard: host-computer-use must prove its private port exists before effect/intent. */
  assertToolDispatchAvailable(executionDomain: ExecutionDomain): void {
    assertToolDispatchAvailable(executionDomain, this.d.hostToolDispatch)
  }

  /** Restores only the durable attempt counter; the recovery path owns every replay decision. */
  restoreToolDispatchAttempt(effectId: string, startSeq: Seq, attempt: ExecuteAttempt): void {
    this.executePermits.restoreConsumed({ effectId, startSeq, attempt, owner: this.executePermitOwner })
  }

  runInference(): Promise<StepOutcome> {
    return runInference(this)
  }

  /**
   * Rebuilds the turn's in-memory state after a kill. The nonce is read back off the last
   * `request/header` of this turn rather than minted afresh: every untrusted region in the request
   * embeds it, so a new one changes `derived_hash` and makes a resumed turn look like a different
   * request than the one it is continuing. Excluding the envelope text from the hash instead would
   * take the injected content out of the integrity check, which is the thing the hash is for.
   */
  async rehydrateTurn(op: OpStateObj): Promise<void> {
    await this.restoreGrants()
    const range = { fromSeq: op.meta.triggerSeq, toSeq: this.lastSeq, lane: this.lane }
    const [lastRow] = await this.d.log.scan({ ...range, type: 'request/header', order: 'desc', limit: 1 })
    const last = lastRow?.data as RequestHeaderData | undefined
    let calls = 0
    for await (const page of scanPages((q) => this.d.log.scan(q), { ...range, type: 'tool/call' }))
      calls += page.length
    const ordinal =
      op.phase.kind === 'tools' ? Math.max(calls, ...op.phase.batch.calls.map((c) => c.ordinal + 1)) : calls
    const turn = this.freshTurn(ordinal, op.meta.triggerSeq)
    const budget = await this.rehydratedBudget(op)
    if (budget !== undefined) turn.budgetCap = budget
    if (last?.envelopeNonce) {
      turn.nonce = last.envelopeNonce
      turn.lastHeader = last
      turn.lastHeaderSeq = lastRow?.seq ?? null
    }
    if (!this.turn) this.hooks.resetTurn?.()
    this.turn = turn
  }

  runToolsPhase(): Promise<StepOutcome> {
    return runToolsPhase(this)
  }

  /**
   * Picks up whatever the last process left in flight. It is the first call a fresh writer makes on
   * a ledger that may not have been closed cleanly, and it is separate from `step()` on purpose:
   * `step()` advances a turn whose state is sound, and this is what makes it sound again.
   */
  resume(o: { mode?: ResumeMode } = {}): Promise<ResumeReport> {
    if (this.activeOps > 0)
      return Promise.reject(
        new CoreError('E_LANE_BUSY', 'the session is running; there is nothing to resume'),
      )
    const op = this.op()
    // Already restored and not running: restoring it again would replace the live turn.
    if (o.mode !== 'close' && op && this.turn)
      return Promise.resolve({ state: 'resumed', phase: op.phase.kind, actions: [] })
    const resuming = this.active(() => resumeSession(this, o), false)
    const settled = resuming.then(
      () => undefined,
      () => undefined,
    )
    this.resuming = settled
    void settled.then(() => {
      if (this.resuming === settled) this.resuming = undefined
    })
    return resuming
  }

  /**
   * Counts one run/step/resume in progress for as long as `fn` runs. A run or step waits for a
   * resume in progress first, and counts while it waits, so no second resume can start before it.
   */
  private async active<T>(fn: () => Promise<T>, afterResume = true): Promise<T> {
    this.activeOps++
    try {
      while (afterResume && this.resuming) await this.resuming
      return await fn()
    } finally {
      this.activeOps--
    }
  }

  /** Dispatches on the phase the ledger says the lane is in, and advances it by exactly one edge. */
  async step(): Promise<StepOutcome> {
    return this.active(() =>
      this.d.withModelSnapshot
        ? this.d.withModelSnapshot(() => this.stepWithModelSnapshot())
        : this.stepWithModelSnapshot(),
    )
  }

  private async stepWithModelSnapshot(): Promise<StepOutcome> {
    const op = this.op()
    if (op?.control.status === 'cancel_requested') return finishAborted(this)
    return this.loopDriver.step(this.ac.signal)
  }

  /** Runs the configured compaction mechanism or records an unavailable-runner failure. */
  async runCompaction(): Promise<StepOutcome> {
    return runCompaction(this)
  }

  /** Polls external artifact jobs through the default loop operation. */
  async runDeferred(): Promise<StepOutcome> {
    return runDeferred(this)
  }

  /**
   * Asks for the work in flight to stop, and says who asked. The record lands before the signal so
   * that a cancellation outlives the controller that delivered it.
   */
  abort(by: Actor = this.d.actor): Promise<AbortResult> {
    return abortSession(this, by).then(async (result) => {
      await Promise.all([
        this.loopDriver?.cancel(),
        ...this.runtimeInstances.map((instance) => instance.runtime.cancel()),
      ])
      return result
    })
  }

  run(opts: { until: 'turn-end' | 'idle'; signal: AbortSignal }): Promise<TurnOutcome> {
    const previous = this.running
    const work = this.active(async () => {
      if (previous) {
        const outcome = await previous
        // A queued cancellation must not reset the active run's signal or claim its next input.
        if (opts.signal.aborted) return { reason: 'aborted' as const, lastSeq: this.lastSeq }
        // Concurrent admissions share a stop/failure boundary; a later explicit run can resume.
        if (outcome.reason !== 'completed') return outcome
      }
      return this.runTurns(opts)
    })
    this.running = work
    return work.finally(() => {
      if (this.running === work) this.running = undefined
    })
  }

  private async runTurns(opts: { until: 'turn-end' | 'idle'; signal: AbortSignal }): Promise<TurnOutcome> {
    // Fresh work gets a fresh scope, unless the session is closed, in which case there is no work.
    if (!this.closing) this.ac = new AbortController()
    this.turnEndError = undefined
    const onAbort = () => void this.abort().catch(() => undefined)
    opts.signal.addEventListener('abort', onAbort, { once: true })
    // A caller whose signal was already aborted gets no event, and would otherwise have handed in a
    // cancelled run that runs.
    if (opts.signal.aborted) onAbort()
    // A phase edge that reports where it went without writing where it went leaves step() reading
    // the same phase forever. Bound consecutive edges without a committed program-counter change,
    // independently of the optional step budget. Real tool dispatch and model steps advance the
    // counter, so long tasks and large tool batches do not consume this livelock allowance.
    const maxEdges = 64
    let edges = 0
    const progress = () =>
      this.loop.id === defaultLoopFactory.id && this.loop.version === defaultLoopFactory.version
        ? this.opSeq()
        : this.lastSeq
    let cursor = progress()
    try {
      for (;;) {
        const nextCursor = progress()
        if (nextCursor !== cursor) edges = 0
        cursor = nextCursor
        if (++edges > maxEdges) {
          // A bound that throws hands the caller an exception off the declared outcome contract and
          // leaves the turn open with no `turn/end`, which is a state no resume can read. The turn
          // ends on the ledger instead and the invariant row says why it was ended.
          const phase = this.op()?.phase.kind ?? null
          const error = { code: 'E_RELATION', message: `run loop made no progress at phase ${phase}` }
          await this.diag('invariant', { kind: 'run-no-progress', edges, phase })
          if (this.op()) await this.abandon('run-no-progress', error)
          return { reason: 'error', lastSeq: this.lastSeq, error }
        }
        // A cancel that arrived while no turn was open (a Stop sent right behind a Send) could only
        // pull the signal: there was no row to mark. The turn exists now, so put the request on the
        // ledger before anything runs under it; step() ends a marked turn without starting more work.
        const open = this.op()
        if (open && this.ac.signal.aborted && !this.closing && open.control.status !== 'cancel_requested')
          await this.abort()
        let out: StepOutcome
        const quietEntry = this.d.quiet?.enter(this.d.quietGroup ?? this.key)
        if (quietEntry) await quietEntry
        try {
          out = await this.step()
        } catch (err) {
          if (!this.op() && (err as { code?: string })?.code === 'PARKED')
            return { reason: 'parked', lastSeq: this.lastSeq }
          // `run()` promises an outcome. An exception out of a phase — an extension hook that throws
          // is the reachable case — would otherwise reject and leave the turn and its step open, a
          // state only a resume can clear. The turn ends on the ledger with the failure that ended
          // it, and the diagnostic row keeps the original findable. A direct `step()` call still
          // throws, so a bug is not hidden from whoever is debugging one.
          const phase = this.op()?.phase.kind ?? null
          const error = {
            code: 'E_STEP_FAILED',
            message: err instanceof Error ? err.message : String(err),
          }
          // A fail-closed hook or request stage that the cancel cut off throws like a failure, but
          // the user asked for the stop. End the turn as the stop it was, with no invariant row for
          // what the cancel itself caused; if even that cannot be written, the failure path below
          // still records and closes the turn.
          if (this.ac.signal.aborted && !this.closing) {
            try {
              await this.abort()
              const stopped = await finishAborted(this)
              if (stopped.phase === 'terminal')
                return {
                  reason: stopped.reason ?? 'aborted',
                  lastSeq: this.lastSeq,
                  ...(this.turnEndError ? { error: this.turnEndError } : {}),
                }
            } catch {
              /* fall through to the failure close */
            }
          }
          await this.diag('invariant', { kind: 'step-threw', phase, message: error.message })
          if (this.op()) await this.abandon('step-threw', error)
          return { reason: 'error', lastSeq: this.lastSeq, error }
        } finally {
          this.d.quiet?.leave(this.d.quietGroup ?? this.key)
        }
        if (out.phase === 'terminal')
          return {
            reason: out.reason ?? 'completed',
            lastSeq: this.lastSeq,
            ...(this.turnEndError ? { error: this.turnEndError } : {}),
          }
        // Idle means no open turn and nothing queued to open one. Looping on would only spin:
        // acceptInput answers false every time, and new input arrives by enqueue then run().
        if (out.phase === 'idle') return { reason: 'completed', lastSeq: this.lastSeq }
        const op = this.op()
        // Reconciliation gets the boundary before a deferred poll or retry backoff can put this run
        // to sleep. The Host decides whether this point means immediate, step, or turn policy.
        await this.d.quiet?.yieldPoint('step', this.d.quietGroup ?? this.key)
        if (out.phase === 'deferred' && op?.phase.kind === 'deferred') {
          // A queued/running external job is expected waiting, not an in-process phase livelock.
          // Do not spend the edge guard while the configured delay is pacing real polls; the run's
          // AbortSignal remains the bound for a job that never completes.
          edges--
          await this.sleep(this.preset.deferred.pollMs)
        }
        if (op?.phase.kind === 'inference' && op.phase.gen.status === 'retry_wait') {
          const wait = Date.parse(op.phase.gen.notBefore) - this.d.clock()
          if (wait > 0) await this.sleep(wait)
        }
      }
    } finally {
      opts.signal.removeEventListener('abort', onAbort)
      await this.d.quiet?.yieldPoint('turn', this.d.quietGroup ?? this.key)
    }
  }

  /**
   * The last resort of the two paths that have already given up on the turn. It writes the step's
   * close alongside the turn's, because the situations that reach it are the ones with a step still
   * open — and it is the only place allowed to keep going after a failed close, so the failure is
   * written down rather than dropped. A closer that fails silently is worse than none, because the
   * caller is told the turn ended.
   */
  private async abandon(kind: string, error: { code: string; message: string }): Promise<void> {
    try {
      await closeTurn(this, 'error', { error })
    } catch (err) {
      await this.diag('invariant', {
        kind: 'turn-close-failed',
        after: kind,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * The retry backoff. It races the session's abort, so an interrupt cuts the wait rather than
   * being noticed only once the delay is over — and a fitted `Timers` that never fires cannot hold
   * the loop past a cancellation.
   */
  private sleep(ms: number): Promise<void> {
    const timers = this.d.timers ?? DEFAULT_TIMERS
    return new Promise<void>((res) => {
      if (this.ac.signal.aborted) {
        res()
        return
      }
      let handle: unknown
      const onAbort = (): void => {
        timers.clearTimeout(handle)
        res()
      }
      this.ac.signal.addEventListener('abort', onAbort, { once: true })
      handle = timers.setTimeout(() => {
        this.ac.signal.removeEventListener('abort', onAbort)
        res()
      }, ms)
    })
  }

  resumeApproval(ticket: string, verdict: Verdict, decidedBy: Actor): Promise<{ seq: Seq }> {
    return resumeApproval(this, ticket, verdict, decidedBy)
  }

  expireApprovals(): Promise<number> {
    return expireApprovals(this)
  }

  invokeTool(
    name: string,
    args: unknown,
    o: {
      signal?: AbortSignal
      depth: number
      parentEffectId?: string
      nestedLease?: NestedToolLease
      onPark?: (event: EventInput) => void
      onAttachmentRead?: () => void
    },
  ): Promise<ToolResult> {
    return invokeTool(this, name, args, o)
  }

  runNestedTool<T>(
    concurrencySafe: boolean,
    run: (lease: NestedToolLease) => Promise<T>,
    parent?: NestedToolLease,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.nestedToolScheduler.run(concurrencySafe, run, parent, signal)
  }

  setPreset(view: PresetView): Promise<Seq> {
    return setPreset(this, view)
  }

  setModel(sel: {
    slot: string
    route: string
    model: string
    thinking?: ThinkingLevel | null
    contextWindow?: number | null
  }): Promise<Seq> {
    return setModel(this, sel)
  }

  async setYolo(enabled: boolean, operator: Actor): Promise<Seq> {
    if (typeof enabled !== 'boolean') throw new CoreError('E_ENVELOPE', 'invalid yolo state')
    const inspected = inspectJsonData(operator, 16 * 1024)
    if (!inspected.ok) throw new CoreError('E_ENVELOPE', 'invalid yolo operator')
    const checked = validateActor(inspected.value)
    if (!checked.ok) throw new CoreError('E_ENVELOPE', 'invalid yolo operator')
    const actor = checked.value
    // A projection triggered by the committed event must wait for the matching live flag.
    return this.exclusively(async () => {
      const r = await this.d.log.append([
        sysEvent(
          { actor, lane: this.lane },
          'x/core/yolo-switch',
          {
            version: 1,
            to: enabled,
            operatorId: actor.id,
            sessionKey: this.key,
            lane: this.lane,
            profileHash: this.d.resolvedProfileHash,
            sessionOwner: { id: this.d.actor.id, org: this.d.actor.org },
          },
          { ignorable: true },
        ),
      ])
      this.yolo = enabled
      return r.firstSeq
    })
  }

  append(tx: EventInput[]) {
    return this.d.log.append(tx)
  }
  discardNewSession(): Promise<void> {
    return this.d.log.discardNewSession()
  }
  scan(q: ScanQuery): Promise<Event[]> {
    return this.d.log.scan(q)
  }
  latest(register: string, key?: string): unknown {
    return this.d.log.latest(
      register,
      key ?? (register === 'artifact/job' || register === 'harness/entry' ? '' : this.lane),
    )
  }
  surface(): readonly SurfaceNode[] {
    return this.d.surface.nodes()
  }
  projectUI(upto?: Seq, opts: Omit<UIOptions, 'sessionKey' | 'upto' | 'lane'> = {}): Promise<CoreUITimeline> {
    if (upto !== undefined && (!Number.isSafeInteger(upto) || upto < 0))
      return Promise.reject(
        new CoreError('E_ENVELOPE', 'UI upper bound must be a nonnegative safe sequence number'),
      )
    return this.exclusively(async () => ({ ...(await this.projectFull(upto, opts)), yolo: this.yolo }))
  }

  private async projectFull(
    upto: Seq | undefined,
    opts: Omit<UIOptions, 'sessionKey' | 'upto' | 'lane'>,
  ): Promise<CoreUITimeline> {
    this.guardProjection()
    const head = this.lastSeq
    if (this.d.ui.complete && this.d.ui.upto === head && (upto === undefined || upto >= head)) {
      const usage = this.headProjectionUsage()
      return this.withChildTraces(await this.d.ui.view({ ...opts, usage }))
    }
    return this.projectHistoricalUI(Math.min(upto ?? head, head), opts)
  }

  projectUIPatch(
    after: Seq,
    upto?: Seq,
    opts: Omit<UIOptions, 'sessionKey' | 'upto' | 'lane'> = {},
  ): Promise<CoreUIProjectionUpdate> {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      (upto !== undefined && (!Number.isSafeInteger(upto) || upto < after))
    )
      return Promise.reject(new CoreError('E_ENVELOPE', 'invalid UI projection patch bounds'))
    return this.exclusively<CoreUIProjectionUpdate>(async () => {
      this.guardProjection()
      // Historical cuts and dynamic extension fills retain the authoritative slow path. Production
      // daemon calls do not supply fills, so a live head hit stays wholly on the event-driven cell.
      const live = () =>
        this.d.ui.complete && this.d.ui.upto === this.lastSeq && (upto === undefined || upto >= this.lastSeq)
      if (!live() || opts.fills) return { kind: 'replace', timeline: await this.projectFull(upto, opts) }
      if (opts.surface !== 'web') {
        const usage = this.headProjectionUsage()
        const patch = this.d.ui.journalPatch(after, usage)
        if (!patch) return { kind: 'replace', timeline: await this.d.ui.view({ ...opts, usage }) }
        return { kind: 'patch', patch }
      }
      const traces = await this.probeChildren(this.d.ui.turnList)
      if (!live()) return { kind: 'replace', timeline: await this.projectFull(upto, opts) }
      const turns = this.d.ui.turnList
      const owners = subagentOwners(turns)
      const usage = this.headProjectionUsage()
      const patch = this.d.ui.journalPatch(after, usage)
      const replace = async (): Promise<CoreUIProjectionUpdate> => {
        const timeline = await this.d.ui.view({ ...opts, usage })
        for (const turn of timeline.turns) embedChildTraces(turn, owners, traces)
        return { kind: 'replace', timeline }
      }
      if (!patch) return replace()
      // A child's rows are not parent events, so its owner turn is sent again to every baseline
      // that may predate the last change seen, in addition to the turns the journal changed.
      const listed = new Set(
        patch.turnChanges.map((change) => (change.op === 'remove' ? change.id : change.turn.id)),
      )
      const stale = new Set<string>()
      for (const [key, trace] of traces) {
        const owner = owners.get(key)
        if (trace && owner && after <= trace.changedAtParentSeq && !listed.has(owner.turnId))
          stale.add(owner.turnId)
      }
      const removals = patch.turnChanges.filter((change) => change.op === 'remove')
      const upserts = patch.turnChanges.filter((change) => change.op === 'upsert')
      for (const change of upserts) embedChildTraces(change.turn, owners, traces)
      // Past one projection page of re-sent turns (e.g. right after an opening folded many children
      // at its own head), a replacement lets the client reopen within a budget instead.
      let resent = 0
      for (const [index, turn] of turns.entries()) {
        if (!stale.has(turn.id)) continue
        const copy = structuredClone(turn)
        embedChildTraces(copy, owners, traces)
        resent += encoder.encode(JSON.stringify(copy)).byteLength
        if (resent > UI_PROJECTION_DEFAULT_MAX_BYTES) return replace()
        upserts.push({ op: 'upsert', index, turn: copy })
      }
      upserts.sort((a, b) => a.index - b.index)
      return { kind: 'patch', patch: { ...patch, turnChanges: [...removals, ...upserts] } }
    }).then((update) =>
      update.kind === 'patch'
        ? { ...update, patch: { ...update.patch, yolo: this.yolo } }
        : { ...update, timeline: { ...update.timeline, yolo: this.yolo } },
    )
  }

  projectUIOpening(
    opts: Omit<UIOptions, 'sessionKey' | 'upto' | 'lane'> & {
      maxNodes?: number
      maxBytes?: number
    } = {},
  ): Promise<CoreUIOpeningResult> {
    const maxNodes = opts.maxNodes ?? UI_OPENING_DEFAULT_MAX_NODES
    const maxBytes = opts.maxBytes ?? UI_PROJECTION_DEFAULT_MAX_BYTES
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
      return Promise.reject(new CoreError('E_ENVELOPE', 'invalid UI opening bounds'))
    return this.exclusively(async () => {
      this.guardProjection()
      const web = opts.surface === 'web'
      if (this.d.ui.complete && this.d.ui.upto === this.lastSeq) {
        const usage = this.headProjectionUsage()
        if (!web) return this.d.ui.opening({ ...opts, maxNodes, maxBytes, usage })
        const traces = await this.probeChildren(this.d.ui.turnList)
        const embed = webTurns(subagentOwners(this.d.ui.turnList), traces)
        const opening = await this.d.ui.opening({
          ...opts,
          maxNodes,
          maxBytes,
          usage,
          turnBytes: embed.bytes,
        })
        return {
          ...opening,
          timeline: { ...opening.timeline, turns: opening.timeline.turns.map(embed.take) },
        }
      }

      const head = this.lastSeq
      const full = await this.projectHistoricalUI(head, opts, !web)
      const embed = web
        ? webTurns(subagentOwners(full.turns), await this.probeChildren(full.turns))
        : undefined
      const page = boundedTimelinePage(
        full.nodes,
        full.nodes.length,
        maxNodes,
        maxBytes,
        embed && turnCharge(full.turns, embed.bytes),
      )
      const turns = turnsForNodes(full.turns, page.nodes)
      return {
        timeline: { ...full, nodes: page.nodes, turns: embed ? turns.map(embed.take) : turns },
        hasEarlier: page.hasEarlier,
        startIndex: page.startIndex,
        totalNodes: page.totalNodes,
      }
    }).then((opening) => ({ ...opening, timeline: { ...opening.timeline, yolo: this.yolo } }))
  }

  projectUIHistory(
    cut: Seq,
    beforeIndex: number,
    opts: Omit<UIOptions, 'sessionKey' | 'upto' | 'lane'> & {
      limit?: number
      maxBytes?: number
    } = {},
  ): Promise<CoreUIHistoryPage> {
    const limit = opts.limit ?? UI_HISTORY_DEFAULT_LIMIT
    const maxBytes = opts.maxBytes ?? UI_PROJECTION_DEFAULT_MAX_BYTES
    if (
      !Number.isSafeInteger(cut) ||
      cut < 0 ||
      cut > this.lastSeq ||
      !Number.isSafeInteger(beforeIndex) ||
      beforeIndex < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    )
      return Promise.reject(new CoreError('E_ENVELOPE', 'invalid UI history bounds'))
    return this.exclusively(async () => {
      this.guardProjection()
      const web = opts.surface === 'web'
      const live = () => this.d.ui.complete && cut === this.lastSeq && this.d.ui.upto === cut
      if (live()) {
        const traces = web ? await this.probeChildren(this.d.ui.turnList) : undefined
        if (live()) {
          const embed = traces && webTurns(subagentOwners(this.d.ui.turnList), traces)
          const page = this.d.ui.history(cut, beforeIndex, limit, maxBytes, embed?.bytes)
          if (beforeIndex > page.totalNodes)
            throw new CoreError('E_ENVELOPE', 'UI history cursor is outside the captured timeline')
          return embed ? { ...page, turns: page.turns.map(embed.take) } : page
        }
      }

      const full = await this.projectHistoricalUI(cut, opts, !web)
      if (beforeIndex > full.nodes.length)
        throw new CoreError('E_ENVELOPE', 'UI history cursor is outside the captured timeline')
      const embed = web
        ? webTurns(subagentOwners(full.turns), await this.probeChildren(full.turns))
        : undefined
      const page = boundedTimelinePage(
        full.nodes,
        beforeIndex,
        limit,
        maxBytes,
        embed && turnCharge(full.turns, embed.bytes),
      )
      const turns = turnsForNodes(full.turns, page.nodes, false)
      return {
        sessionId: this.key,
        cut,
        ...page,
        turns: embed ? turns.map(embed.take) : turns,
      }
    })
  }

  /**
   * Every projection of this session runs alone: a child probe and the result it feeds are one
   * step, so a change one call observes is either in another call's result or recorded before that
   * call's baseline could pass it. There is no deadline: a storage read that never settles holds
   * every later projection of this session, as it would hold the call itself.
   */
  private exclusively<T>(run: () => Promise<T>): Promise<T> {
    const result = this.projectionTail.then(run)
    this.projectionTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Resolves every child the turns name through the cache; each call records the parent head. */
  private async probeChildren(turns: readonly UITurn[]): Promise<Map<string, ChildTrace | undefined>> {
    const cache = this.childTraces()
    const keys = [...subagentOwners(turns).keys()]
    const found = await Promise.all(keys.map((key) => cache?.resolve(key, this.lastSeq)))
    return new Map(keys.map((key, index) => [key, found[index]]))
  }

  private guardProjection(): void {
    if (this.d.log.faulted) throw new CoreError('E_STORAGE_FAULT', 'session is faulted; reopen')
    if (this.closingOrClosed || this.d.log.isClosed) throw new CoreError('E_CLOSED', 'session closed')
  }

  private headProjectionUsage() {
    const target = resolveModel(this, 'primary')
    const model = this.d.provider
      .models()
      .find((entry) => entry.route === target.route && entry.id === target.model)
    return this.d.ui.usage({
      route: target.route,
      model: {
        ...model,
        id: target.model,
        contextWindow: contextWindowFor(this, target.route, target.model),
      },
      settings: {
        ...(this.preset.model.thinking.primary === undefined
          ? {}
          : { thinking: this.preset.model.thinking.primary }),
        contextWindow: contextWindowFor(this, target.route, target.model),
      },
      thinking: this.preset.model.thinking.primary ?? 'off',
      autoCompact: this.preset.compaction.enabled,
    })
  }

  private async projectHistoricalUI(
    cut: Seq,
    opts: Omit<UIOptions, 'sessionKey' | 'upto' | 'lane'>,
    children = true,
  ): Promise<CoreUITimeline> {
    const events: Event[] = []
    let fromSeq = 1
    while (fromSeq <= cut) {
      const page = await this.d.log.scan({ fromSeq, toSeq: cut, limit: SCAN_PAGE_MAX })
      if (page.length === 0)
        throw new CoreError('E_STORAGE_FAULT', 'UI projection scan ended before its captured cut', {
          fromSeq,
          cut,
        })
      for (const event of page) {
        if (event.seq !== fromSeq)
          throw new CoreError('E_STORAGE_FAULT', 'UI projection scan returned a non-contiguous ledger', {
            expectedSeq: fromSeq,
            actualSeq: event.seq,
            cut,
          })
        events.push(event)
        fromSeq += 1
      }
    }
    // The register holds only the head's program counter, so it speaks for the cut only while no
    // commit has moved the head past it; any earlier cut shows the running operation coarsely.
    const op = cut === this.d.log.lastSeq ? currentOp(this.d.log, this.lane) : undefined
    const target = resolveModel(this, 'primary')
    const model = this.d.provider
      .models()
      .find((entry) => entry.route === target.route && entry.id === target.model)
    const usage = projectUsage({
      events,
      upto: cut,
      lane: this.lane,
      route: target.route,
      model: {
        ...model,
        id: target.model,
        contextWindow: contextWindowFor(this, target.route, target.model),
      },
      settings: {
        ...(this.preset.model.thinking.primary === undefined
          ? {}
          : { thinking: this.preset.model.thinking.primary }),
        contextWindow: contextWindowFor(this, target.route, target.model),
      },
      thinking: this.preset.model.thinking.primary ?? 'off',
      contextTokens: contextTokensAtCut(events, this.lane, cut),
      autoCompact: this.preset.compaction.enabled,
    })
    const timeline = await projectUI(events, {
      sessionKey: this.key,
      lane: this.lane,
      upto: cut,
      ...opts,
      usage,
      ...(op === undefined ? {} : { op }),
    })
    return children ? this.withChildTraces(timeline) : timeline
  }

  private async withChildTraces(timeline: CoreUITimeline): Promise<CoreUITimeline> {
    if (collectSubagentKeys(timeline.turns).length === 0) return timeline
    const totals = timeline.turns[0]?.usage.totals ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    }
    const cache = this.childTraces()
    const head = this.lastSeq
    const load = async (childKey: string) => {
      const found = await cache?.resolve(childKey, head)
      return found ? structuredClone(found.spans as UISpan[]) : undefined
    }
    await attachChildTraces(timeline.turns, load, totals)
    return timeline
  }

  private childTraces(): ChildTraceCache | undefined {
    const storage = this.d.log.storage
    if (!hasChildControl(storage)) return undefined
    this.childTraceCache ??= new ChildTraceCache(this.key, {
      lookup: (childKey) => storage.lookupByKey(childKey),
      scan: (childKey, q) => storage.scan(childKey, q),
    })
    return this.childTraceCache
  }
  async exportRlaf(range: RlafRange = {}): Promise<RlafDump> {
    // Capture one bound before the await, so concurrent appends cannot change this export's cut.
    const upto = this.lastSeq
    const events = await scanAll((q) => this.d.log.scan(q), { toSeq: upto })
    return exportRlaf(events, range)
  }
  pendingEffects(): EffectTree {
    return effectTree(this.state)
  }
  private closePromise: Promise<void> | undefined

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    unbindChildFactory(this.key)
    this.executePermits.close()
    this.ac.abort()
    this.closePromise = Promise.resolve().then(async () => {
      const failures: unknown[] = []
      await Promise.resolve()
        .then(() => this.loopDriver?.dispose())
        .catch((error: unknown) => failures.push(error))
      if (this.loopContext) disposeLoopContext(this.loopContext)
      await Promise.all(
        this.runtimeInstances.map((instance) =>
          Promise.resolve()
            .then(() => instance.runtime.dispose())
            .catch((error: unknown) => failures.push(error)),
        ),
      )
      await this.hooks.shutdown?.().catch((error: unknown) => failures.push(error))
      await this.d.log.close().catch((error: unknown) => failures.push(error))
      await this.d.workspaceLease?.close().catch((error: unknown) => failures.push(error))
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'session close failed')
    })
    return this.closePromise
  }
}
