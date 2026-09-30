// generated from schema/runtime/prototype.json by tools/gen-runtime.ts — do not edit
import type { TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { type ValidationResult, validateAgainst } from '../../../protocol-validation/src/validate.js'
import * as RuntimeSchemas from '../../gen/ts/runtime-prototype.js'
import { jcs } from '../jcs.js'

export type { ValidationError, ValidationResult } from '../../../protocol-validation/src/validate.js'
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
} from '../../gen/ts/runtime-prototype.js'
export { RuntimeSchemas }

export interface RuntimeWireTypes {
  AckOutboxRequest: RuntimeSchemas.AckOutboxRequest
  AckOutboxResult: RuntimeSchemas.AckOutboxResult
  ActionDependency: RuntimeSchemas.ActionDependency
  ActionRef: RuntimeSchemas.ActionRef
  ActionResultView: RuntimeSchemas.ActionResultView
  ActionVisibilityValue: RuntimeSchemas.ActionVisibilityValue
  AdmissionProbe: RuntimeSchemas.AdmissionProbe
  AdmitInvocationResult: RuntimeSchemas.AdmitInvocationResult
  AdmitQueryResult: RuntimeSchemas.AdmitQueryResult
  AdvanceProviderRequest: RuntimeSchemas.AdvanceProviderRequest
  AdvanceRunRequest: RuntimeSchemas.AdvanceRunRequest
  ApprovalRequest: RuntimeSchemas.ApprovalRequest
  ApprovalTaintAck: RuntimeSchemas.ApprovalTaintAck
  AuthorizationPreparation: RuntimeSchemas.AuthorizationPreparation
  BindingRef: RuntimeSchemas.BindingRef
  BlobRef: RuntimeSchemas.BlobRef
  CallContextWire: RuntimeSchemas.CallContextWire
  ClaimOutboxRequest: RuntimeSchemas.ClaimOutboxRequest
  ClaimOutboxResult: RuntimeSchemas.ClaimOutboxResult
  CloseInvocationRequest: RuntimeSchemas.CloseInvocationRequest
  CloseInvocationResult: RuntimeSchemas.CloseInvocationResult
  CommitControlRequest: RuntimeSchemas.CommitControlRequest
  CommitGuard: RuntimeSchemas.CommitGuard
  ConversationAdmission: RuntimeSchemas.ConversationAdmission
  ConversationContribution: RuntimeSchemas.ConversationContribution
  DataRef: RuntimeSchemas.DataRef
  Digest: RuntimeSchemas.Digest
  DispatchAdmissionProbe: RuntimeSchemas.DispatchAdmissionProbe
  DispatchAdmissionRequest: RuntimeSchemas.DispatchAdmissionRequest
  DispatchAdmissionResult: RuntimeSchemas.DispatchAdmissionResult
  DispatchAtomicDomain: RuntimeSchemas.DispatchAtomicDomain
  DispatchBudgetPlan: RuntimeSchemas.DispatchBudgetPlan
  DomainEvent: RuntimeSchemas.DomainEvent
  DomainReference: RuntimeSchemas.DomainReference
  ExternalRequestRef: RuntimeSchemas.ExternalRequestRef
  FailOutboxRequest: RuntimeSchemas.FailOutboxRequest
  FailOutboxResult: RuntimeSchemas.FailOutboxResult
  HookEventName: RuntimeSchemas.HookEventName
  HookRegistrationSnapshot: RuntimeSchemas.HookRegistrationSnapshot
  HookResultSet: RuntimeSchemas.HookResultSet
  HookStageRequest: RuntimeSchemas.HookStageRequest
  Id: RuntimeSchemas.Id
  InlineResultHookEvaluation: RuntimeSchemas.InlineResultHookEvaluation
  InlineResultHookSource: RuntimeSchemas.InlineResultHookSource
  InvocationAdmission: RuntimeSchemas.InvocationAdmission
  JsonValue: RuntimeSchemas.JsonValue
  LoopTransition: RuntimeSchemas.LoopTransition
  Money: RuntimeSchemas.Money
  NextStep: RuntimeSchemas.NextStep
  OutboxClaim: RuntimeSchemas.OutboxClaim
  OutboxRecord: RuntimeSchemas.OutboxRecord
  OwnerRef: RuntimeSchemas.OwnerRef
  PreparedAction: RuntimeSchemas.PreparedAction
  ProbeActionResultRequest: RuntimeSchemas.ProbeActionResultRequest
  ProbeActionResultResult: RuntimeSchemas.ProbeActionResultResult
  Provenance: RuntimeSchemas.Provenance
  ProviderTransition: RuntimeSchemas.ProviderTransition
  PruneRecordVersionsRequest: RuntimeSchemas.PruneRecordVersionsRequest
  PruneRecordVersionsResult: RuntimeSchemas.PruneRecordVersionsResult
  PublishActionResultResult: RuntimeSchemas.PublishActionResultResult
  QueryAdmission: RuntimeSchemas.QueryAdmission
  QueryUsageFlush: RuntimeSchemas.QueryUsageFlush
  ReadGuard: RuntimeSchemas.ReadGuard
  Receipt: RuntimeSchemas.Receipt
  ReceiptIntakeRequest: RuntimeSchemas.ReceiptIntakeRequest
  ReceiptIntakeResult: RuntimeSchemas.ReceiptIntakeResult
  ReceiptResultHandling: RuntimeSchemas.ReceiptResultHandling
  RequestIdentity: RuntimeSchemas.RequestIdentity
  ResultHookPlan: RuntimeSchemas.ResultHookPlan
  ResultVisibilityCommit: RuntimeSchemas.ResultVisibilityCommit
  RetentionRef: RuntimeSchemas.RetentionRef
  RetryAdvice: RuntimeSchemas.RetryAdvice
  RetryPolicy: RuntimeSchemas.RetryPolicy
  RunAdmission: RuntimeSchemas.RunAdmission
  RuntimeControlCommand: RuntimeSchemas.RuntimeControlCommand
  RuntimeError: RuntimeSchemas.RuntimeError
  RuntimeErrorCode: RuntimeSchemas.RuntimeErrorCode
  SchemaRef: RuntimeSchemas.SchemaRef
  ScopeRef: RuntimeSchemas.ScopeRef
  SignalDelivery: RuntimeSchemas.SignalDelivery
  SignalIntakeReceipt: RuntimeSchemas.SignalIntakeReceipt
  SnapshotRef: RuntimeSchemas.SnapshotRef
  StateAuthorityRef: RuntimeSchemas.StateAuthorityRef
  StateCommitReceipt: RuntimeSchemas.StateCommitReceipt
  StateLeaseRequest: RuntimeSchemas.StateLeaseRequest
  StateLeaseResult: RuntimeSchemas.StateLeaseResult
  StateOpenRequest: RuntimeSchemas.StateOpenRequest
  StateOpenResult: RuntimeSchemas.StateOpenResult
  Timestamp: RuntimeSchemas.Timestamp
  TypeId: RuntimeSchemas.TypeId
  UInt53: RuntimeSchemas.UInt53
  UsageFact: RuntimeSchemas.UsageFact
  VersionedState: RuntimeSchemas.VersionedState
  WaitClause: RuntimeSchemas.WaitClause
  WaitCondition: RuntimeSchemas.WaitCondition
  WriterClaim: RuntimeSchemas.WriterClaim
}

const schemas: { [K in keyof RuntimeWireTypes]: TSchema } = RuntimeSchemas

function validUInt53(schema: TSchema, value: unknown, references: Record<string, TSchema> = {}): boolean {
  const refs = { ...references, ...(schema.$defs as Record<string, TSchema> | undefined) }
  if (schema.$id) refs[schema.$id] = schema
  if (schema.$id === 'UInt53' || schema.$ref === 'UInt53') return !Object.is(value, -0)
  if (schema.$ref) {
    const target = refs[schema.$ref]
    if (!target) throw new Error('unresolved runtime schema reference')
    return validUInt53(target, value, refs)
  }
  if (schema.anyOf) {
    return (schema.anyOf as TSchema[]).some(
      (branch) => Value.Check(branch, Object.values(refs), value) && validUInt53(branch, value, refs),
    )
  }
  if (schema.allOf) return (schema.allOf as TSchema[]).every((branch) => validUInt53(branch, value, refs))
  if (schema.type === 'array' && Array.isArray(value) && schema.items)
    return value.every((item) => validUInt53(schema.items, item, refs))
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    const props = schema.properties as Record<string, TSchema> | undefined
    for (const [key, item] of Object.entries(value)) {
      const property = props?.[key]
      if (property && !validUInt53(property, item, refs)) return false
      const patterns = schema.patternProperties as Record<string, TSchema> | undefined
      for (const [pattern, rule] of Object.entries(patterns ?? {}))
        if (new RegExp(pattern).test(key) && !validUInt53(rule, item, refs)) return false
      if (!property && typeof schema.additionalProperties === 'object') {
        if (!validUInt53(schema.additionalProperties, item, refs)) return false
      }
    }
  }
  return true
}

export function validateRuntime<K extends keyof RuntimeWireTypes>(
  name: K,
  value: unknown,
): ValidationResult<RuntimeWireTypes[K]> {
  try {
    jcs(value)
  } catch {
    return { ok: false, errors: [{ path: '', message: 'invalid JSON wire value', code: 'TYPE' }] }
  }
  const schema = schemas[name]
  const result = validateAgainst<RuntimeWireTypes[K]>(schema, value)
  if (result.ok && !validUInt53(schema, value))
    return { ok: false, errors: [{ path: '', message: 'UInt53 rejects negative zero', code: 'RANGE' }] }
  return result
}
