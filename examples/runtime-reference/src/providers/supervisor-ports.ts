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

/** Structural declarations for the reference implementation. They match what a Host assembler supplies to the
 * default implementation member for member, but nothing here is imported from it. */
export type RefIssued = Readonly<{ context: CallContext; check(): void }>
export type RefTicket = Readonly<{
  admission: W.RunAdmission
  stateAuthorityRef: W.StateAuthorityRef
  runKey: W.Id
  grantRef: W.Id
}>
export type RefAction = Readonly<{
  actionId: W.Id
  key: string
  parentActionId: W.Id | null
  state: W.ActionState
  obligation: 'mandatory' | 'detached'
  owner: W.OwnerRef
  attempt: Readonly<{ number: number; state: string }> | null
  attemptId: W.Id | null
  view: Readonly<{ visibility: 'absent' | 'pending' | 'ready'; outcome: string | null }>
  receiptId: W.Id | null
  recordRevision: number
  dependsOn: readonly W.Id[]
  deadline: W.Timestamp
}>
export type RefFacts = Readonly<{
  snapshot: W.Id
  runId: W.Id
  sessionId: W.Id
  workspaceId: W.Id
  bindingId: W.Id
  loop: W.BindingRef
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
  actions: readonly RefAction[]
}>
export type RefPorts = Readonly<{
  clock(): number
  sessionControl?: Pick<
    StateStoreControl,
    'readSessionControl' | 'submitSessionControl' | 'sessionControlStatus'
  >
  admission?: Readonly<{
    coordinate(
      draft: Readonly<{
        runKey: W.Id
        admission: Omit<W.RunAdmission, 'fingerprint' | 'packagePinReceipt'>
        stateAuthorityRef: W.StateAuthorityRef
        grantRef: W.Id
      }>,
      context: CallContext,
    ): Promise<Outcome<W.AdmissionProbe>>
    cancel(ticketId: W.Id, fingerprint: W.Digest, context: CallContext): Promise<Outcome<W.AdmissionProbe>>
    recall(ticketId: W.Id, context: CallContext): Promise<Outcome<RefTicket | null>>
    recallByRun(runId: W.Id, context: CallContext): Promise<Outcome<RefTicket | null>>
  }>
  releases?: Readonly<{
    select(
      presetRef: W.Id,
      context: CallContext,
    ): Promise<
      Outcome<
        Readonly<{
          releaseSetId: W.Id
          runBinding: W.RunBinding
          stateAuthorityRef: W.StateAuthorityRef
          lane: string
        }>
      >
    >
    bound(
      releaseSetId: W.Id,
      bindingId: W.Id,
      context: CallContext,
    ): Promise<
      Outcome<Readonly<{
        releaseSetId: W.Id
        runBinding: W.RunBinding
        stateAuthorityRef: W.StateAuthorityRef
        lane: string
      }> | null>
    >
  }>
  identity?: Readonly<{
    issue(
      runRef: W.RunRef,
      purpose: 'read' | 'drive' | 'dispatch' | 'cancel',
      deadline: W.Timestamp,
      signal: AbortSignal,
    ): Promise<Outcome<RefIssued>>
    issueRuntime(purpose: 'scan', deadline: W.Timestamp, signal: AbortSignal): Promise<Outcome<RefIssued>>
    check(context: CallContext): void
    delegationExpiresAt(context: CallContext): W.Timestamp | null
  }>
  limits?: Readonly<{
    workflowLifetimeMs: number
    actionDefaultTimeoutMs: number
    pollMs: number
    leaseTtlMs: number
    cycleMs: number
    invocationMs: number
    graceMs: number
    queryAllowance: number
  }>
  read?: Readonly<{
    run(context: CallContext, runId: W.Id, snapshot: W.Id | null): Promise<Outcome<RefFacts | null>>
    signals(
      context: CallContext,
      runId: W.Id,
      afterSeq: number,
      limit: number,
    ): Promise<Outcome<W.PageSignal>>
    parameters(context: CallContext, runId: W.Id): Promise<Outcome<W.SupervisorSessionParametersResult>>
    receipt(
      context: CallContext,
      namespace: Readonly<{ runId: W.Id; parentActionId: W.Id | null }>,
      ref: W.ActionRef,
      snapshot: W.Id | null,
    ): Promise<Outcome<Readonly<{ snapshot: W.Id; result: W.SupervisorActionReceiptResult }>>>
  }>
  advance?: Pick<
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
  writer?: Readonly<{
    acquire(
      sessionId: W.Id,
      context: CallContext,
    ): Promise<Outcome<Readonly<{ writerId: W.Id; writerEpoch: number; release(): Promise<void> }>>>
  }>
  runs?: Readonly<{
    open(
      admission: W.RunAdmission,
      signal: AbortSignal,
    ): Promise<
      Outcome<
        Readonly<{
          loop: LoopProvider
          reads: LoopReadPorts
          actions: ReadonlyMap<string, ActionProviderFactory>
          factoryContextFor(binding: W.BindingRef): FactoryContext
          close(): Promise<void>
        }>
      >
    >
  }>
  effects?: Readonly<{
    dispatch(
      request: Readonly<{
        committedActionRef: W.ActionRef
        expectedWriterEpoch: number
        expectedAuthorityEpoch: number
      }>,
      context: CallContext,
    ): Promise<Outcome<unknown>>
    reconcile(
      request: Readonly<{ attemptRef: W.AttemptRef }>,
      context: CallContext,
    ): Promise<Outcome<unknown>>
    cancel(
      request: Readonly<{ attemptRef: W.AttemptRef; reason: string }>,
      context: CallContext,
    ): Promise<Outcome<unknown>>
  }>
  directory?: Readonly<{
    listAttention(
      context: CallContext,
      page: Readonly<{ after: string | null; limit: number }>,
    ): Promise<
      Outcome<
        Readonly<{
          items: readonly Readonly<{ sessionId: W.Id; runId: W.Id; authority: W.StateAuthorityRef }>[]
          next: string | null
        }>
      >
    >
  }>
  notify?: Readonly<{
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
  }>
  dispatchPlan?: Readonly<{
    plan(
      action: RefAction,
      guard: W.CommitGuard,
      context: CallContext,
    ): Promise<
      Outcome<
        Readonly<{
          decisionRef: W.DataRef
          atomicDomain: W.DispatchAtomicDomain
          budget: W.DispatchBudgetPlan
          requestIdentity: W.RequestIdentity | null
        }>
      >
    >
  }>
}>
