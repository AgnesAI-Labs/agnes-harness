// generated from schema/runtime/prototype.json by tools/gen-runtime.ts — do not edit
import type * as Wire from '@agnes/protocol/runtime'

export type {
  AckOutboxRequest,
  AckOutboxResult,
  ActionDependency,
  ActionRef,
  ActionResultView,
  ActionVisibilityValue,
  AdmissionProbe,
  AdmitInvocationResult,
  AdmitQueryResult,
  AdvanceProviderRequest,
  AdvanceRunRequest,
  ApprovalRequest,
  ApprovalTaintAck,
  AuthorizationPreparation,
  BindingRef,
  BlobRef,
  CallContextWire,
  ClaimOutboxRequest,
  ClaimOutboxResult,
  CloseInvocationRequest,
  CloseInvocationResult,
  CommitControlRequest,
  CommitGuard,
  ConversationAdmission,
  ConversationContribution,
  DataRef,
  Digest,
  DispatchAdmissionProbe,
  DispatchAdmissionRequest,
  DispatchAdmissionResult,
  DispatchAtomicDomain,
  DispatchBudgetPlan,
  DomainEvent,
  DomainReference,
  ExternalRequestRef,
  FailOutboxRequest,
  FailOutboxResult,
  HookEventName,
  HookRegistrationSnapshot,
  HookResultSet,
  HookStageRequest,
  Id,
  InlineResultHookEvaluation,
  InlineResultHookSource,
  InvocationAdmission,
  JsonValue,
  LoopTransition,
  Money,
  NextStep,
  OutboxClaim,
  OutboxRecord,
  OwnerRef,
  PreparedAction,
  ProbeActionResultRequest,
  ProbeActionResultResult,
  Provenance,
  ProviderTransition,
  PruneRecordVersionsRequest,
  PruneRecordVersionsResult,
  PublishActionResultResult,
  QueryAdmission,
  QueryUsageFlush,
  ReadGuard,
  Receipt,
  ReceiptIntakeRequest,
  ReceiptIntakeResult,
  ReceiptResultHandling,
  RequestIdentity,
  ResultHookPlan,
  ResultVisibilityCommit,
  RetentionRef,
  RetryAdvice,
  RetryPolicy,
  RunAdmission,
  RuntimeControlCommand,
  RuntimeError,
  RuntimeErrorCode,
  SchemaRef,
  ScopeRef,
  SignalDelivery,
  SignalIntakeReceipt,
  SnapshotRef,
  StateAuthorityRef,
  StateCommitReceipt,
  StateLeaseRequest,
  StateLeaseResult,
  StateOpenRequest,
  StateOpenResult,
  Timestamp,
  TypeId,
  UInt53,
  UsageFact,
  VersionedState,
  WaitClause,
  WaitCondition,
  WriterClaim,
} from '@agnes/protocol/runtime'

export type CallContext = Readonly<Wire.CallContextWire & { signal: AbortSignal }>
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: Wire.RuntimeError }

export interface StateStoreControl {
  open(request: Wire.StateOpenRequest, context: CallContext): Promise<Outcome<Wire.StateOpenResult>>
  lease(request: Wire.StateLeaseRequest, context: CallContext): Promise<Outcome<Wire.StateLeaseResult>>
  createRun(admission: Wire.RunAdmission, context: CallContext): Promise<Outcome<Wire.AdmissionProbe>>
  probeAdmission(ticketId: Wire.Id, context: CallContext): Promise<Outcome<Wire.AdmissionProbe>>
  admitInvocation(
    request: Wire.InvocationAdmission,
    context: CallContext,
  ): Promise<Outcome<Wire.AdmitInvocationResult>>
  admitQuery(request: Wire.QueryAdmission, context: CallContext): Promise<Outcome<Wire.AdmitQueryResult>>
  closeInvocation(
    request: Wire.CloseInvocationRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.CloseInvocationResult>>
  advanceRun(request: Wire.AdvanceRunRequest, context: CallContext): Promise<Outcome<Wire.StateCommitReceipt>>
  advanceProvider(
    request: Wire.AdvanceProviderRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.StateCommitReceipt>>
  dispatchAdmission(
    request: Wire.DispatchAdmissionRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.DispatchAdmissionResult>>
  probeDispatchAdmission(
    admissionId: Wire.Id,
    context: CallContext,
  ): Promise<Outcome<Wire.DispatchAdmissionProbe>>
  commitControl(
    request: Wire.CommitControlRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.StateCommitReceipt>>
  intakeReceipt(
    request: Wire.ReceiptIntakeRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.ReceiptIntakeResult>>
  publishActionResult(
    request: Wire.ResultVisibilityCommit,
    context: CallContext,
  ): Promise<Outcome<Wire.PublishActionResultResult>>
  probeActionResult(
    request: Wire.ProbeActionResultRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.ProbeActionResultResult>>
  acceptInbox(delivery: Wire.SignalDelivery, context: CallContext): Promise<Outcome<Wire.SignalIntakeReceipt>>
  claimOutbox(
    request: Wire.ClaimOutboxRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.ClaimOutboxResult>>
  ackOutbox(request: Wire.AckOutboxRequest, context: CallContext): Promise<Outcome<Wire.AckOutboxResult>>
  failOutbox(request: Wire.FailOutboxRequest, context: CallContext): Promise<Outcome<Wire.FailOutboxResult>>
  pruneRecordVersions(
    request: Wire.PruneRecordVersionsRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.PruneRecordVersionsResult>>
}
