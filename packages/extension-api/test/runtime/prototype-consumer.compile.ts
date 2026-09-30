import type { CallContext, Outcome, StateStoreControl } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'

// This consumer pins the method-to-payload contract independently of generator metadata.
interface PrototypeControlContract {
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

export function generatedContractMatches(store: StateStoreControl): PrototypeControlContract {
  return store
}

export function declaredContractMatches(store: PrototypeControlContract): StateStoreControl {
  return store
}

import type {
  AdmissionProbe,
  DispatchBudgetPlan,
  HookStageRequest,
  Id,
  OwnerRef,
  ReceiptIntakeRequest,
  ResultHookPlan,
} from '@agnes/protocol/runtime'

export function probeAdmission(
  store: StateStoreControl,
  context: CallContext,
  ticketId: Id,
): Promise<Outcome<AdmissionProbe>> {
  return store.probeAdmission(ticketId, context)
}

export function exposeRequiredTypes(value: {
  owner: OwnerRef
  stage: HookStageRequest
  resultPlan: ResultHookPlan
  receipt: ReceiptIntakeRequest
  budget: DispatchBudgetPlan
}) {
  return value
}

type RequiredMethod =
  | 'open'
  | 'lease'
  | 'createRun'
  | 'probeAdmission'
  | 'admitInvocation'
  | 'admitQuery'
  | 'closeInvocation'
  | 'advanceRun'
  | 'advanceProvider'
  | 'dispatchAdmission'
  | 'probeDispatchAdmission'
  | 'commitControl'
  | 'intakeReceipt'
  | 'publishActionResult'
  | 'probeActionResult'
  | 'acceptInbox'
  | 'claimOutbox'
  | 'ackOutbox'
  | 'failOutbox'
  | 'pruneRecordVersions'

export const methods: { [K in RequiredMethod]: K extends keyof StateStoreControl ? true : never } = {
  open: true,
  lease: true,
  createRun: true,
  probeAdmission: true,
  admitInvocation: true,
  admitQuery: true,
  closeInvocation: true,
  advanceRun: true,
  advanceProvider: true,
  dispatchAdmission: true,
  probeDispatchAdmission: true,
  commitControl: true,
  intakeReceipt: true,
  publishActionResult: true,
  probeActionResult: true,
  acceptInbox: true,
  claimOutbox: true,
  ackOutbox: true,
  failOutbox: true,
  pruneRecordVersions: true,
}

// @ts-expect-error A caller cannot replace the full owner identity with a run ID string.
export const invalidOwner: OwnerRef = 'run'
// @ts-expect-error Receipt intake must declare how its result becomes visible.
export const invalidResultHandling: ReceiptIntakeRequest['resultHandling'] = { kind: 'skip' }
