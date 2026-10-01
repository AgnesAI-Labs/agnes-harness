// generated from schema/runtime by tools/gen-runtime.ts — do not edit
import type * as Wire from '@agnes/protocol/runtime'
import type { CallContext, Outcome } from './public-api.js'

export interface EffectStreamHandle {
  readonly streamId: Wire.Id
  readonly chunks: AsyncIterable<Wire.StreamChunk>
  readonly ended: Promise<Wire.TransportEnd>
  cancel(reason: string): Promise<void>
  close(): Promise<void>
}

export interface StreamHandle {
  readonly streamId: Wire.Id
  readonly durability: 'ephemeral' | 'durable'
  readonly chunks: AsyncIterable<Wire.StreamChunk>
  readonly ended: Promise<Wire.StreamEnd>
  cancel(reason: string): Promise<void>
  close(): Promise<void>
}

export interface StateStoreControl {
  acceptServiceCommand(
    request: Wire.ServiceCommandAdmission,
    context: CallContext,
  ): Promise<Outcome<Wire.ServiceCommandRecord>>
  readServiceCommand(
    request: Wire.StateStoreControlReadServiceCommandRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.StateStoreControlReadServiceCommandResult>>
  importConversation(
    request: Wire.ConversationImportRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.ConversationImportResult>>
  probeConversationImport(
    requestId: Wire.Id,
    context: CallContext,
  ): Promise<Outcome<Wire.StateStoreControlProbeConversationImportResult>>
  open(request: Wire.StateOpenRequest, context: CallContext): Promise<Outcome<Wire.StateOpenResult>>
  lease(request: Wire.StateLeaseRequest, context: CallContext): Promise<Outcome<Wire.StateLeaseResult>>
  createChild(request: Wire.ChildCreateRequest, context: CallContext): Promise<Outcome<Wire.StateOpenResult>>
  admitInvocation(
    request: Wire.InvocationAdmission,
    context: CallContext,
  ): Promise<Outcome<Wire.AdmitInvocationResult>>
  admitQuery(request: Wire.QueryAdmission, context: CallContext): Promise<Outcome<Wire.AdmitQueryResult>>
  closeInvocation(
    request: Wire.CloseInvocationRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.CloseInvocationResult>>
  dispatchAdmission(
    request: Wire.DispatchAdmissionRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.DispatchAdmissionResult>>
  probeDispatchAdmission(
    admissionId: Wire.Id,
    context: CallContext,
  ): Promise<Outcome<Wire.DispatchAdmissionProbe>>
  pruneRecordVersions(
    request: Wire.PruneRecordVersionsRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.PruneRecordVersionsResult>>
  commitControl(
    request: Wire.CommitControlRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.StateCommitReceipt>>
  createRun(admission: Wire.RunAdmission, context: CallContext): Promise<Outcome<Wire.AdmissionProbe>>
  cancelAdmission(
    ticketId: Wire.Id,
    fingerprint: Wire.Digest,
    context: CallContext,
  ): Promise<Outcome<Wire.AdmissionProbe>>
  probeAdmission(ticketId: Wire.Id, context: CallContext): Promise<Outcome<Wire.AdmissionProbe>>
  cancelPreparedActionAdmission(
    request: Wire.StateStoreControlCancelPreparedActionAdmissionRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.PreparedActionAdmissionProbe>>
  probePreparedActionAdmission(
    request: Wire.StateStoreControlProbePreparedActionAdmissionRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.PreparedActionAdmissionProbe>>
  readSessionControl(
    request: Wire.StateStoreControlReadSessionControlRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.SessionControlState>>
  submitSessionControl(
    request: Wire.SessionControlRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.SessionControlResult>>
  sessionControlStatus(
    request: Wire.StateStoreControlSessionControlStatusRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.StateStoreControlSessionControlStatusResult>>
  acceptInbox(delivery: Wire.SignalDelivery, context: CallContext): Promise<Outcome<Wire.SignalIntakeReceipt>>
  fireTimer(
    request: Wire.StateStoreControlFireTimerRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.SignalIntakeReceipt>>
  registerStream(
    request: Wire.StreamRegistration,
    context: CallContext,
  ): Promise<Outcome<Wire.StateStoreControlRegisterStreamResult>>
  appendStream(
    request: Wire.StateStoreControlAppendStreamRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.StateStoreControlAppendStreamResult>>
  claimOutbox(
    request: Wire.ClaimOutboxRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.ClaimOutboxResult>>
  ackOutbox(request: Wire.AckOutboxRequest, context: CallContext): Promise<Outcome<Wire.AckOutboxResult>>
  failOutbox(request: Wire.FailOutboxRequest, context: CallContext): Promise<Outcome<Wire.FailOutboxResult>>
  beginReconciliation(
    request: Wire.StateStoreControlBeginReconciliationRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.ReconciliationCheckValue>>
  completeReconciliation(
    request: Wire.StateStoreControlCompleteReconciliationRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.ReconciliationCheckValue>>
  advanceRun(request: Wire.AdvanceRunRequest, context: CallContext): Promise<Outcome<Wire.StateCommitReceipt>>
  advanceProvider(
    request: Wire.AdvanceProviderRequest,
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
  acceptBridgeChild(
    request: Wire.LegacyBridgeRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.StateStoreControlAcceptBridgeChildResult>>
  probeBridgeChild(
    request: Wire.StateStoreControlProbeBridgeChildRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.StateStoreControlProbeBridgeChildResult>>
  beginMigration(
    request: Wire.StateStoreControlBeginMigrationRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.MigrationToken>>
  commitMigratedRun(
    request: Wire.StateStoreControlCommitMigratedRunRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.StateCommitReceipt>>
  abortMigration(
    request: Wire.StateStoreControlAbortMigrationRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.StateCommitReceipt>>
  probeMigration(upgradeId: Wire.Id, context: CallContext): Promise<Outcome<Wire.MigrationProbe>>
}

export interface MaintenanceStore {
  commit(
    request: Wire.MaintenanceStoreCommitRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.MaintenanceStoreCommitResult>>
  query(request: Wire.ServiceQuery, context: CallContext): Promise<Outcome<Wire.QueryReply>>
}

export interface AuthorityTransferControl {
  fence(
    request: Wire.AuthorityTransferControlFenceRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.AuthorityFence>>
  export(
    request: Wire.AuthorityTransferControlExportRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.AuthorityExport>>
  exportPage(
    request: Wire.AuthorityTransferControlExportPageRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.AuthorityTransferControlExportPageResult>>
  import(
    request: Wire.AuthorityTransferControlImportRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.AuthorityTransferControlImportResult>>
  verify(
    request: Wire.AuthorityTransferControlVerifyRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.MigrationValidation>>
  activate(
    request: Wire.AuthorityTransferControlActivateRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.AuthorityTransferProbe>>
  abort(
    request: Wire.AuthorityTransferControlAbortRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.AuthorityTransferProbe>>
  probe(
    request: Wire.AuthorityTransferControlProbeRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.AuthorityTransferProbe>>
}

export interface DomainReducer {
  reduce(input: Wire.DomainReducerReduceRequest): Outcome<Wire.DataRef>
}

export interface ProjectionReadContext {
  readonly call: CallContext
  readonly snapshot: string
  query(request: Wire.ServiceQuery): Promise<Outcome<Wire.QueryReply>>
  resolveData(ref: Wire.DataRef): Promise<Outcome<Wire.JsonValue>>
}

export interface DomainSelector {
  selectAuthorized(
    input: Wire.DomainSelectorSelectAuthorizedRequest,
    context: ProjectionReadContext,
  ): Promise<Outcome<Wire.DomainSelectorSelectAuthorizedResult>>
}

export interface DomainCommandHandler {
  prepare(
    frame: Wire.DomainCommandFrame,
    context: ProjectionReadContext,
  ): Promise<Outcome<Wire.DomainCommandPlan>>
}

export interface AuthorityDirectoryControl {
  compareAndSwap(
    request: Wire.AuthorityDirectoryCompareAndSwapRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.AuthorityDirectoryCompareAndSwapResult>>
}

export type ByteRangeResult = {
  bytes: Uint8Array
  offset: Wire.UInt53
  totalBytes: Wire.UInt53
  digest: Wire.Digest
}

export interface ByteReadStream {
  readonly chunks: AsyncIterable<Uint8Array>
  readonly ended: Promise<Outcome<Wire.ArtifactReadStreamEndResult>>
  cancel(reason: string): Promise<void>
  close(): Promise<void>
}

export interface BlobReadPort {
  readRange(request: Wire.BlobReadRangeRequest, context: CallContext): Promise<Outcome<ByteRangeResult>>
  openRead(request: Wire.BlobOpenReadRequest, context: CallContext): Promise<Outcome<ByteReadStream>>
}

export interface ArtifactAccessPort {
  describe(input: Wire.ArtifactDescribeInput, context: CallContext): Promise<Outcome<Wire.ArtifactViewRef>>
  openDownload(
    input: Wire.ArtifactOpenDownloadRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.ArtifactDownloadTicket>>
  readRange(
    input: Wire.ArtifactClientReadRangeRequest,
    context: CallContext,
  ): Promise<Outcome<ByteRangeResult>>
  openStream(
    input: Wire.ArtifactClientOpenStreamRequest,
    context: CallContext,
  ): Promise<Outcome<ByteReadStream>>
}

export interface ClientCommandIngressPort {
  accept(request: Wire.ClientCommandRequest, context: CallContext): Promise<Outcome<Wire.ClientCommandReply>>
}

export interface InteractionAdmissionControl {
  acceptResponse(
    request: Wire.InteractionClientRespondRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.InteractionResponseStatus>>
  respondApproval(
    request: Wire.ApprovalRespondRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.InteractionResponseStatus>>
  formLink(
    request: Wire.InteractionFormLinkRequest,
    context: CallContext,
  ): Promise<Outcome<Wire.InteractionFormLink>>
}
