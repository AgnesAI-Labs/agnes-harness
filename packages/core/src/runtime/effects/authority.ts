import type {
  ActionContext,
  CallContext,
  FactoryContext,
  LeafActionProvider,
  Outcome,
} from '@agnes/extension-api/runtime'
import type {
  ActionFrame,
  ActionRef,
  AttemptRef,
  CloseReason,
  DataRef,
  EffectPortsInvokeRequest,
  EffectResult,
  EffectsDispatchRequest,
  EffectsDispatchResult,
  EffectsReconcileRequest,
  ExternalRequestRef,
  Health,
  RequestIdentity,
} from '@agnes/protocol/runtime'

/** Installed owner must derive these facts from committed State records, not caller DTOs. */
export interface CommittedEffectAction {
  readonly action: ActionRef
  readonly frame: ActionFrame
  readonly version: DataRef
}
export interface AdmittedEffectAttempt {
  readonly original: CommittedEffectAction
  readonly attempt: AttemptRef
  readonly requestIdentity: RequestIdentity
  readonly frame: ActionFrame
  readonly context: ActionContext
  readonly leaf: LeafActionProvider
  /** Original durable probe. Unknown and settled attempts must never execute again. */
  readonly externalRequests: readonly ExternalRequestRef[]
  readonly state: EffectsDispatchResult
}
/** Private deployment boundary; implementations own original State, authentication and codecs. */
export interface EffectsAuthority {
  now(): string
  open(config: DataRef, factory: FactoryContext): Promise<Outcome<void>>
  checkCurrent(context: CallContext): Promise<void>
  /** Synchronous actual current/epoch/permit gate, immediately before each physical port entry. */
  assertSend(attempt: AdmittedEffectAttempt, request: EffectPortsInvokeRequest, context: CallContext): void
  readCommitted(request: EffectsDispatchRequest, context: CallContext): Promise<CommittedEffectAction>
  admit(
    original: CommittedEffectAction,
    request: EffectsDispatchRequest,
    context: CallContext,
  ): Promise<AdmittedEffectAttempt>
  /** Verify the original returned object, durable action/attempt and selected leaf association. */
  assertOriginal(attempt: AdmittedEffectAttempt, context: CallContext): void
  external(attempt: AdmittedEffectAttempt, request: EffectPortsInvokeRequest): ExternalRequestRef
  /** Existing State mark_running, with fixed request identity and real external request. */
  markRunning(attempt: AdmittedEffectAttempt, request: ExternalRequestRef): Promise<void>
  /** Existing intake coordinator; late evidence uses its restricted receipt role, not send permission. */
  intake(attempt: AdmittedEffectAttempt, result: EffectResult): Promise<EffectsDispatchResult>
  /** Persist unknown using the original reconciliation owner, without creating a new attempt. */
  unknown(
    attempt: AdmittedEffectAttempt,
    evidence: readonly ExternalRequestRef[],
    /** Completed original facts, when available; undefined never proves zero usage. */
    completed?: EffectResult,
  ): Promise<EffectsDispatchResult>
  /** Existing begin/complete reconciliation controls and lookup-only selected capability. */
  reconcile(request: EffectsReconcileRequest, context: CallContext): Promise<EffectsDispatchResult>
  publish(
    method: 'dispatch' | 'reconcile',
    result: EffectsDispatchResult,
    context: CallContext,
  ): Promise<DataRef>
  health(context: CallContext): Promise<Outcome<Health>>
  close(reason: CloseReason): Promise<void>
}
