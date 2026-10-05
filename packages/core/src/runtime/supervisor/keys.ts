import type * as W from '@agnes/protocol/runtime'

export const DAY_MS = 86_400_000
/** WORKFLOW_LIFETIME_MS default and the deployment ceiling. */
export const WORKFLOW_LIFETIME_DEFAULT_MS = 30 * DAY_MS
export const WORKFLOW_LIFETIME_CEILING_MS = 365 * DAY_MS

export type Digester = (value: W.JsonValue) => string

export type AdmissionIds = Readonly<{ runKey: string; ticketId: string; runId: string }>

/** Observable retry identity: one (scope, idempotencyKey, spec) triple names one ticket and one run, while the
 * runKey is the idempotencyKey alone, so a different spec under the same key reaches the coordinator's run-key
 * index and conflicts. The material is private; the contract only observes convergence and refusal. */
export function admissionIds(
  scope: W.ScopeRef,
  idempotencyKey: string,
  specDigest: string,
  digest: Digester,
): AdmissionIds {
  const material = digest({
    scope: scope as unknown as W.JsonValue,
    idempotencyKey,
    specDigest,
    purpose: 'supervisor-admit',
  })
  return {
    runKey: idempotencyKey,
    ticketId: `tkt-${material.slice(0, 40)}`,
    runId: `run-${material.slice(0, 40)}`,
  }
}

export function sessionIdOf(scope: W.ScopeRef): string | null {
  return scope.kind === 'session' || scope.kind === 'run' || scope.kind === 'action' ? scope.sessionId : null
}

export function workspaceIdOf(scope: W.ScopeRef): string | null {
  return scope.kind === 'workspace' ||
    scope.kind === 'session' ||
    scope.kind === 'run' ||
    scope.kind === 'action'
    ? scope.workspaceId
    : null
}

/** admittedAt is read once from the trusted clock. A retry must pass the stored value back in. */
export function lifetimeDeadline(
  admittedAtMs: number,
  lifetimeMs: number,
  delegationExpiresAtMs: number | null,
): string {
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > WORKFLOW_LIFETIME_CEILING_MS)
    throw new RangeError('workflow lifetime is outside 1ms..365d')
  const bound = delegationExpiresAtMs === null ? Infinity : delegationExpiresAtMs
  const deadline = Math.min(admittedAtMs + lifetimeMs, bound)
  if (!(deadline > admittedAtMs)) throw new RangeError('delegation has already expired')
  return new Date(deadline).toISOString()
}

/** maxDeadline of an ActionTimebox: the minimum of every persisted bound, never a fresh now()-based value. */
export function maxDeadline(bounds: readonly (string | null)[]): string {
  const known = bounds.filter((bound): bound is string => bound !== null)
  if (known.length === 0) throw new RangeError('no persisted deadline bound')
  return known.reduce((best, bound) => (Date.parse(bound) < Date.parse(best) ? bound : best))
}

export function actionTimebox(
  _observedAt: string,
  defaultTimeoutMs: number,
  bounds: readonly (string | null)[],
): W.ActionTimebox {
  return { defaultTimeoutMs, maxDeadline: maxDeadline(bounds) }
}
