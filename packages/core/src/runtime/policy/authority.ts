import type { CallContext, FactoryContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  ApprovalGrantBindingInput,
  ApprovalGrantListResult,
  ApprovalGrantRecord,
  DataRef,
  JsonValue,
  OwnerRef,
  PermissionClientRevokeGrantRequest,
  PolicyEvaluateRequest,
  SchemaRef,
  Timestamp,
} from '@agnes/protocol/runtime'
import type { PolicyContributor, PreparedPolicyEvidence } from './decision-composition.js'

export interface VerifiedPolicyEvaluation {
  readonly input: PolicyEvaluateRequest
  readonly evidence: PreparedPolicyEvidence
  readonly factsRef: DataRef
  readonly conditions: DataRef
  readonly validUntil: Timestamp
  /** Opaque owner token; it must be checked against current State and permissions after composition. */
  readonly readGuard: object
  readonly policies: readonly PolicyContributor[]
}
export interface VerifiedGrantAccess {
  readonly actorId: string
  readonly actorOrg: string
  readonly profileHash: string
  readonly snapshotId: string
  readonly readGuard: object
}

/** Host-private adapter. Neither serialized facts nor authors can install or issue this authority. */
export interface PolicyAuthority {
  now(): Timestamp
  open(config: DataRef, context: FactoryContext): Promise<Outcome<void>>
  readConfig(reference: DataRef, context: FactoryContext): Promise<Outcome<unknown>>
  read(reference: DataRef, context: CallContext): Promise<Outcome<unknown>>
  /** Verifies provenance/current actor, all binding fields, fixed classification/display, per-scope guardian+usage and once action identity. */
  verifyEvaluation(
    input: PolicyEvaluateRequest,
    context: CallContext,
  ): Promise<Outcome<VerifiedPolicyEvaluation>>
  checkCurrent(readGuard: object, context: CallContext): Promise<Outcome<void>>
  authorizeGrants(
    method: 'listGrants' | 'revokeGrant',
    input: ApprovalGrantBindingInput,
    context: CallContext,
  ): Promise<Outcome<VerifiedGrantAccess>>
  listGrants(
    access: VerifiedGrantAccess,
    input: ApprovalGrantBindingInput,
    context: CallContext,
  ): Promise<Outcome<ApprovalGrantListResult>>
  /** Returns a real durable request owner bound to this subject, request identity and fingerprint, before effects. */
  revokeOwner(
    access: VerifiedGrantAccess,
    input: PermissionClientRevokeGrantRequest,
    context: CallContext,
  ): Promise<Outcome<OwnerRef>>
  /** Owner performs current-auth + request identity/fingerprint CAS + revoke atomically. No activation API. */
  revokeGrant(
    access: VerifiedGrantAccess,
    input: PermissionClientRevokeGrantRequest,
    context: CallContext,
  ): Promise<Outcome<ApprovalGrantRecord>>
  /** Materializes canonical output through the selected, authorized data owner; large values remain Blob. */
  publish(schema: SchemaRef, value: JsonValue, context: CallContext): Promise<Outcome<DataRef>>
  close(): Promise<void>
}
