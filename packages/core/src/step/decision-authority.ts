import type { EventInput, Seq } from '@agnes/core-common/types'
import type { SessionLogImpl } from '@agnes/core-ledger/log/session-log'
import type { DecisionSnapshot, DecisionSpec } from '@agnes/extension-api'
import type { Actor } from '@agnes/protocol'
import { automaticPermissionDecision, isPermissionPurpose, validateActor } from '@agnes/protocol'
import type { DecisionAnswerContext } from './decisions.js'

/** Minimal authority needed by the decision commands; the session supplies the writer gate. */
export interface DecisionAuthority {
  readonly refuseApprovals?: boolean
  /** The role's application declared that core tool gates follow the live parent's full access. */
  readonly delegatedFullAccess?: boolean
  readonly delegatedToolApprovals?: boolean
  readonly key: string
  /** A profile journal uses decision commands without creating a session or granting session access. */
  readonly profileId?: string
  readonly lane: string
  readonly lastSeq: Seq
  readonly closed: boolean
  readonly cancelled: boolean
  readonly actor: Actor
  readonly permissionContext?: import('@agnes/protocol').PermissionContext | undefined
  readonly ttlMs: number
  readonly timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
  readonly log: Pick<
    SessionLogImpl,
    'append' | 'observeCommitted' | 'claimLease' | 'leaseRemainingMs' | 'faulted'
  >
  beforeAttestation?(): Promise<void>
  /** Session-private optional-work admission; profile journals do not install it. */
  admitReviewDecision?(spec: DecisionSpec, source: DecisionSource, wait: boolean): Promise<void>
  historyVerified?(): boolean
  readDecisions(): ReadonlyMap<string, { value: DecisionSnapshot; seq: Seq }>
  clock(): number
  id(): string
  transact<T>(work: () => Promise<T>): Promise<T>
  event(value: DecisionSnapshot): EventInput
}

export interface DecisionSource {
  readonly permission?: true
  readonly owner: string
  readonly operationId: string
  readonly sourcePackage: string
  readonly packageVersion: string
  alive(): void
}
/** Core's own tool gate: the only request a declaring role answers automatically under full access. */
export function coreToolPermission(
  permission: boolean,
  origin: { readonly owner: string; readonly sourcePackage: string },
  spec: DecisionSpec,
): boolean {
  return (
    permission &&
    origin.owner === 'core/tool-permission' &&
    origin.sourcePackage === '@agnes/core' &&
    spec.purpose === 'tool.permission'
  )
}

/** The automatic full-access answer, if any: open to a main session, and to a declaring role for core tool gates only. */
export function automaticAnswer(
  s: DecisionAuthority,
  spec: DecisionSpec,
  permission: boolean,
  origin: { readonly owner: string; readonly sourcePackage: string },
) {
  if (s.refuseApprovals && !(s.delegatedFullAccess === true && coreToolPermission(permission, origin, spec)))
    return undefined
  return automaticPermissionDecision(
    s.permissionContext,
    spec.purpose,
    spec.options,
    permission ? 'permission' : 'question',
    spec.presentation,
  )
}

/** A role may ask a person through Core's tool gate; plugin permission and signature gates stay refused. */
export function delegatedDecisionRefused(
  s: DecisionAuthority,
  source: DecisionSource,
  spec: DecisionSpec,
): boolean {
  return Boolean(
    s.refuseApprovals &&
      (source.permission || isPermissionPurpose(spec.purpose) || spec.purpose === 'business.confirm') &&
      !(s.delegatedToolApprovals !== false && coreToolPermission(source.permission === true, source, spec)),
  )
}

export function humanDecisionActorAllowed(s: DecisionAuthority, context: DecisionAnswerContext): boolean {
  return (
    validateActor(context.actor).ok &&
    context.category === 'human' &&
    context.actor.role !== 'agent' &&
    !(s.refuseApprovals && context.actor.role === 'system')
  )
}
