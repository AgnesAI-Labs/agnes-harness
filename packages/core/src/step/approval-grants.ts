import type { Actor, ApprovalGrant, ApprovalVerdict } from '@agnes/protocol'
import { argvHash } from '../effects/runtime.js'
import type { ApprovalAsked } from '../reduce/shapes.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { SessionImpl } from './session.js'

export type ApprovalGrantBinding = {
  actor: Pick<Actor, 'id' | 'org'>
  profileHash: string
  toolId: string
  scope: string
  policyVersion: string
}

export const sessionGrantKey = (input: {
  actor: Pick<Actor, 'id' | 'org'>
  sessionKey: string
  toolId: string
  scope: string
}): string => sha256Hex(canonicalJson(input))

export function approvalScopesForCall(toolId: string, scopes: readonly string[]): string[] {
  const ordered = [...new Set(scopes)]
  return ordered.length > 0 ? ordered : [`tool:${toolId}:execute`]
}

export function permanentGrantMatches(grant: ApprovalGrant, binding: ApprovalGrantBinding): boolean {
  return (
    grant.revokedAt === undefined &&
    grant.profileHash === binding.profileHash &&
    grant.actorId === binding.actor.id &&
    grant.actorOrg === binding.actor.org &&
    grant.toolId === binding.toolId &&
    grant.scope === binding.scope &&
    grant.policyVersion === binding.policyVersion
  )
}

export function approvalBindingHash(input: {
  sessionKey: string
  stepId: string
  toolUseId: string
  args: unknown
  policyHash: string
  scope: string
}): string {
  return sha256Hex(
    canonicalJson({
      sessionKey: input.sessionKey,
      stepId: input.stepId,
      toolUseId: input.toolUseId,
      argvHash: argvHash(input.args),
      policyHash: input.policyHash,
      scope: input.scope,
    }),
  )
}

export function permanentGrantId(input: { sessionKey: string; toolUseId: string; scope: string }): string {
  return `grant-${sha256Hex(canonicalJson(input))}`
}

export type PersistedToolApproval = {
  requestId: string
  verdict: ApprovalVerdict
  grantId?: string
  via: 'sync' | 'callback' | 'timeout' | 'guardian'
  decidedAt: string
}

/**
 * Finds a decision already durably bound to this exact call and scope. This is the common crash
 * recovery path for synchronous, callback, and guardian decisions: once the ledger says what was
 * decided, no caller is asked and no guardian is invoked a second time.
 */
export async function persistedToolApproval(
  s: SessionImpl,
  input: {
    toolUseId: string
    args: unknown
    scope: string
    policyHash: string
    policyVersion: string
  },
): Promise<PersistedToolApproval | undefined> {
  const call = s.state.toolCalls.get(input.toolUseId)
  if (!call || call.lane !== s.lane) return undefined
  const expected = approvalBindingHash({
    sessionKey: s.key,
    stepId: `${call.turn}/${call.step}`,
    toolUseId: input.toolUseId,
    args: input.args,
    policyHash: input.policyHash,
    scope: input.scope,
  })
  for (const [requestId, decision] of [...s.state.decisions].reverse()) {
    if (decision.lane !== s.lane || !decision.askedSeq) continue
    if (decision.via === 'callback' && !s.state.resumedRequests.has(requestId)) continue
    const row = (
      await s.d.log.scan({ fromSeq: decision.askedSeq, toSeq: decision.askedSeq, lane: s.lane })
    )[0]
    if (
      row?.type !== 'approval/asked' ||
      row.origin !== 'system' ||
      row.trust !== 'trusted' ||
      row.actor.id !== s.d.actor.id ||
      row.actor.org !== s.d.actor.org
    )
      continue
    const asked = row.data as ApprovalAsked
    if (
      asked.requestId !== requestId ||
      asked.kind !== 'tool' ||
      asked.toolUseId !== input.toolUseId ||
      asked.scope !== input.scope ||
      asked.policyVersion !== input.policyVersion ||
      asked.bindingHash !== expected
    )
      continue
    const decidedRow = (await s.d.log.scan({ fromSeq: decision.seq, toSeq: decision.seq, lane: s.lane }))[0]
    if (decidedRow?.type !== 'approval/decided') continue
    if (
      decision.via !== 'callback' &&
      (decidedRow.origin !== 'system' ||
        decidedRow.trust !== 'trusted' ||
        decidedRow.actor.id !== s.d.actor.id ||
        decidedRow.actor.org !== s.d.actor.org)
    )
      continue
    return {
      requestId,
      verdict: decision.verdict,
      via: decision.via,
      decidedAt: decidedRow.ts,
      ...(decision.grantId ? { grantId: decision.grantId } : {}),
    }
  }
  return undefined
}

export function newPermanentGrant(
  input: ApprovalGrantBinding & { grantId: string; createdAt: string },
): ApprovalGrant {
  return {
    grantId: input.grantId,
    profileHash: input.profileHash,
    actorId: input.actor.id,
    actorOrg: input.actor.org,
    toolId: input.toolId,
    scope: input.scope,
    policyVersion: input.policyVersion,
    createdAt: input.createdAt,
  }
}

/** Restores only grants whose original identity and argument binding can still be proved. */
export async function restoreSessionGrants(s: SessionImpl): Promise<void> {
  for (const [requestId, decision] of s.state.decisions) {
    if (decision.verdict !== 'allowed-session' || decision.lane !== s.lane || !decision.askedSeq) continue
    // Callback decisions become usable only after their continuation was consumed. A guardian
    // decision is already part of the same trusted transaction as its asked row and is restored on
    // reopen like a synchronous decision; otherwise a process restart would silently shrink a
    // session-scoped grant back to one call.
    if (decision.via === 'callback' && !s.state.resumedRequests.has(requestId)) continue
    if (decision.via === 'timeout') continue
    const askedRow = (
      await s.d.log.scan({ fromSeq: decision.askedSeq, toSeq: decision.askedSeq, lane: s.lane })
    )[0]
    if (
      askedRow?.type !== 'approval/asked' ||
      askedRow.origin !== 'system' ||
      askedRow.trust !== 'trusted' ||
      askedRow.actor.id !== s.d.actor.id ||
      askedRow.actor.org !== s.d.actor.org
    )
      continue
    const decidedRow = (await s.d.log.scan({ fromSeq: decision.seq, toSeq: decision.seq, lane: s.lane }))[0]
    if (decidedRow?.type !== 'approval/decided') continue
    if (
      decision.via !== 'callback' &&
      (decidedRow.origin !== 'system' ||
        decidedRow.trust !== 'trusted' ||
        decidedRow.actor.id !== s.d.actor.id ||
        decidedRow.actor.org !== s.d.actor.org)
    )
      continue
    const asked = askedRow.data as ApprovalAsked
    if (asked.requestId !== requestId || asked.kind !== 'tool' || !asked.toolUseId) continue
    const call = s.state.toolCalls.get(asked.toolUseId)
    if (!call || call.lane !== s.lane) continue
    const row = (await s.d.log.scan({ fromSeq: call.seq, toSeq: call.seq, lane: s.lane }))[0]
    if (row?.type !== 'tool/call') continue
    const data = row.data as { toolUseId: string; name: string; args: unknown; policyHash?: string }
    if (data.toolUseId !== asked.toolUseId || data.name !== call.name) continue
    if (!asked.scope || !asked.policyVersion) continue
    if (!data.policyHash) continue
    const binding = approvalBindingHash({
      sessionKey: s.key,
      stepId: `${call.turn}/${call.step}`,
      toolUseId: asked.toolUseId,
      args: data.args,
      policyHash: data.policyHash,
      scope: asked.scope,
    })
    if (asked.bindingHash !== binding) continue
    s.sessionAllows.add(
      sessionGrantKey({
        actor: s.d.actor,
        sessionKey: s.key,
        toolId: data.name,
        scope: asked.scope,
      }),
    )
  }
}
