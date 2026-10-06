import type {
  ActionProviderFactory,
  CallContext,
  FactoryContext,
  LoopProvider,
  LoopReadPorts,
  Outcome,
  StateStoreControl,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import type { ActionFact } from './completion.js'
import type { AttemptFact } from './recovery.js'
import type { ActionView } from './wait.js'

/** Every port is narrow, structural and optional: an absent port makes exactly the methods that need it refuse.
 * core never imports Host or AI types; the Host assembler adapts its own objects to these shapes. */
export type SessionControlPort = Pick<
  StateStoreControl,
  'readSessionControl' | 'submitSessionControl' | 'sessionControlStatus'
>

export type MethodEntry = Readonly<{
  needs: readonly SupervisorPortName[]
  run(deployment: SupervisorDeployment, input: unknown, context: CallContext): Promise<Outcome<unknown>>
}>

export type SupervisorTicketDraft = Readonly<{
  runKey: W.Id
  admission: Omit<W.RunAdmission, 'fingerprint' | 'packagePinReceipt'>
  stateAuthorityRef: W.StateAuthorityRef
  grantRef: W.Id
}>

/** What the maintenance journal stored for one issued ticket; replaying it reproduces the original draft exactly. */
export type RecalledTicket = Readonly<{
  admission: W.RunAdmission
  stateAuthorityRef: W.StateAuthorityRef
  runKey: W.Id
  grantRef: W.Id
}>
/** coordinate/cancel exist on the Host coordinator; recall/recallByRun are new read-only seams. */
export interface SupervisorAdmissionPort {
  coordinate(draft: SupervisorTicketDraft, context: CallContext): Promise<Outcome<W.AdmissionProbe>>
  cancel(ticketId: W.Id, fingerprint: W.Digest, context: CallContext): Promise<Outcome<W.AdmissionProbe>>
  recall(ticketId: W.Id, context: CallContext): Promise<Outcome<RecalledTicket | null>>
  recallByRun(runId: W.Id, context: CallContext): Promise<Outcome<RecalledTicket | null>>
}

/** Only a branded published release may produce this; never a caller DTO. */
export type PublishedRelease = Readonly<{
  releaseSetId: W.Id
  runBinding: W.RunBinding
  stateAuthorityRef: W.StateAuthorityRef
  lane: string
}>
export interface PublishedReleasePort {
  select(presetRef: W.Id, context: CallContext): Promise<Outcome<PublishedRelease>>
  /** The release a ticket was issued against, still pinned; null when it is not a published release. */
  bound(releaseSetId: W.Id, bindingId: W.Id, context: CallContext): Promise<Outcome<PublishedRelease | null>>
}

/** `context` is the original identity-issued object and must never be copied. `check` is synchronous and
 * throws unless the authorization, delegation, deadline and session-owner mapping are all still current. */
export type IssuedContext = Readonly<{ context: CallContext; check(): void }>
export interface SupervisorIdentityPort {
  issue(
    runRef: W.RunRef,
    purpose: 'read' | 'drive' | 'dispatch' | 'cancel',
    deadline: W.Timestamp,
    signal: AbortSignal,
  ): Promise<Outcome<IssuedContext>>
  /** A runtime-scope context for work that belongs to no run (directory scans); same rules as `issue`. */
  issueRuntime(purpose: 'scan', deadline: W.Timestamp, signal: AbortSignal): Promise<Outcome<IssuedContext>>
  check(context: CallContext): void
  delegationExpiresAt(context: CallContext): W.Timestamp | null
}

export type SupervisorLimits = Readonly<{
  /** 1ms..365d; default 30d. */
  workflowLifetimeMs: number
  actionDefaultTimeoutMs: number
  pollMs: number
  leaseTtlMs: number
  /** One drive cycle's CallContext lifetime; the Loop call itself is bounded by invocationMs. */
  cycleMs: number
  invocationMs: number
  graceMs: number
  queryAllowance: number
}>

export type ActionRow = ActionFact &
  Readonly<{
    key: string
    intentFingerprint: W.Digest
    attempt: AttemptFact | null
    attemptId: W.Id | null
    view: ActionView
    receiptId: W.Id | null
    recordRevision: number
    dependsOn: readonly W.Id[]
    deadline: W.Timestamp
  }>

/** One consistent run snapshot, produced by the State read facade. */
export type RunFacts = Readonly<{
  snapshot: W.Id
  runId: W.Id
  sessionId: W.Id
  workspaceId: W.Id
  /** The RunBinding id: what State's CommitGuard.bindingId is checked against. */
  bindingId: W.Id
  /** The selected Loop provider binding: what RunFrame.bindingId and the Loop itself check. */
  loop: W.BindingRef
  /** Records read for this snapshot, verified again at commit. */
  readGuards: readonly W.ReadGuard[]
  authority: W.StateAuthorityRef
  signalHighWater: number
  interactions: Readonly<Record<string, 'pending' | 'terminal'>>
  revision: number
  writerEpoch: number
  state: W.RunState
  deadline: W.Timestamp
  input: W.DataRef
  continuation: W.VersionedState | null
  conversation: W.ConversationAdmission | null
  cancellation: Readonly<{ reason: string; requestedAt: W.Timestamp; by: W.Id }> | null
  wait: W.WaitCondition | null
  actions: readonly ActionRow[]
}>
export interface SupervisorReadPort {
  /** null = absent or outside the caller window (uniform). */
  run(context: CallContext, runId: W.Id, snapshot: W.Id | null): Promise<Outcome<RunFacts | null>>
  signals(context: CallContext, runId: W.Id, afterSeq: number, limit: number): Promise<Outcome<W.PageSignal>>
  parameters(context: CallContext, runId: W.Id): Promise<Outcome<W.SupervisorSessionParametersResult>>
  /** `namespace.parentActionId` is null for a run-scope caller and the caller's action for an action-scope caller. */
  receipt(
    context: CallContext,
    namespace: Readonly<{ runId: W.Id; parentActionId: W.Id | null }>,
    ref: W.ActionRef,
    snapshot: W.Id | null,
  ): Promise<Outcome<Readonly<{ snapshot: W.Id; result: W.SupervisorActionReceiptResult }>>>
}

export type SupervisorAdvancePort = Pick<
  StateStoreControl,
  | 'admitInvocation'
  | 'admitQuery'
  | 'closeInvocation'
  | 'advanceRun'
  | 'dispatchAdmission'
  | 'probeDispatchAdmission'
  | 'commitControl'
  | 'acceptInbox'
>

/** The adapter owns lease acquire/renew/reclaim (it knows expectedLastSeq) and heartbeats while a claim is held. */
export type WriterClaim = Readonly<{ writerId: W.Id; writerEpoch: number; release(): Promise<void> }>
export interface SupervisorWriterPort {
  /** Idempotent per session: a live claim is returned as is; a lost one is reclaimed with a higher epoch. */
  acquire(sessionId: W.Id, context: CallContext): Promise<Outcome<WriterClaim>>
}

/** Shape mirrors the existing Host run owner (`HostRuntimeLoopRun`). */
export interface RunScope {
  readonly loop: LoopProvider
  readonly reads: LoopReadPorts
  readonly actions: ReadonlyMap<string, ActionProviderFactory>
  factoryContextFor(binding: W.BindingRef): FactoryContext
  close(): Promise<void>
}
export interface SupervisorRunScopePort {
  open(admission: W.RunAdmission, signal: AbortSignal): Promise<Outcome<RunScope>>
}

/** Write-ahead mark_running before the first external byte is a precondition of recovery. */
export type DispatchOutcome = Readonly<{
  attemptRef: W.AttemptRef
  status: W.AttemptState
  receiptRef: W.ReceiptPointer | null
}>
export interface SupervisorEffectsPort {
  dispatch(
    request: Readonly<{
      committedActionRef: W.ActionRef
      expectedWriterEpoch: number
      expectedAuthorityEpoch: number
    }>,
    context: CallContext,
  ): Promise<Outcome<DispatchOutcome>>
  reconcile(
    request: Readonly<{ attemptRef: W.AttemptRef }>,
    context: CallContext,
  ): Promise<Outcome<DispatchOutcome>>
  /** Cancel an in-flight attempt through its owner. The catalog lists no such method yet. */
  cancel(
    request: Readonly<{ attemptRef: W.AttemptRef; reason: string }>,
    context: CallContext,
  ): Promise<Outcome<DispatchOutcome>>
}

export type AttentionItem = Readonly<{
  sessionId: W.Id
  authority: W.StateAuthorityRef
  runId: W.Id
  reason: 'runnable' | 'wait-satisfied' | 'draining' | 'expired' | 'unknown-due'
}>
/** Cross-session enumeration needs a runtime/maintenance read role; there is no Supervisor-side copy. */
export interface SupervisorDirectoryPort {
  listAttention(
    context: CallContext,
    page: Readonly<{ after: string | null; limit: number }>,
  ): Promise<Outcome<Readonly<{ items: readonly AttentionItem[]; next: string | null }>>>
}

/** At-most-once is NOT promised: events may be lost, repeated or reordered. */
export interface SupervisorNotifyPort {
  subscribe(
    listener: (
      event: Readonly<{
        sessionId: W.Id
        authority: W.StateAuthorityRef
        runId: W.Id | null
        commitId: W.Id
      }>,
    ) => void,
  ): () => void
}

/** The policy decision and budget plan one dispatch needs. The Supervisor never decides either. */
export type DispatchPlan = Readonly<{
  decisionRef: W.DataRef
  atomicDomain: W.DispatchAtomicDomain
  budget: W.DispatchBudgetPlan
  requestIdentity: W.RequestIdentity | null
}>
export interface SupervisorDispatchPlanPort {
  plan(action: ActionRow, guard: W.CommitGuard, context: CallContext): Promise<Outcome<DispatchPlan>>
}

export type SupervisorDeployment = Readonly<{
  clock(): number
  sessionControl?: SessionControlPort
  admission?: SupervisorAdmissionPort
  releases?: PublishedReleasePort
  identity?: SupervisorIdentityPort
  limits?: SupervisorLimits
  read?: SupervisorReadPort
  advance?: SupervisorAdvancePort
  writer?: SupervisorWriterPort
  runs?: SupervisorRunScopePort
  effects?: SupervisorEffectsPort
  dispatchPlan?: SupervisorDispatchPlanPort
  directory?: SupervisorDirectoryPort
  notify?: SupervisorNotifyPort
  /** Absent means the deployment cannot supervise a hard deadline. */
  isolation?(binding: W.BindingRef): 'trusted-in-process' | 'isolated-process' | 'remote'
}>
export type SupervisorPortName = Exclude<keyof SupervisorDeployment, 'clock'>
