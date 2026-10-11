import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { argvHash } from '@agnes/core-effects/effects/runtime'
import { CoreError } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { ApprovalAsked } from '@agnes/core-ledger/reduce/shapes'
import type { Actor, ApprovalGrant, ApprovalVerdict } from '@agnes/protocol'
import type { DecisionHandle } from '@agnes/extension-api'
import { TOOL_DECISION_OWNER } from '../execution/turn/tool-decision.js'
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
  subjectRevision?: string
}): string {
  return sha256Hex(
    canonicalJson({
      sessionKey: input.sessionKey,
      stepId: input.stepId,
      toolUseId: input.toolUseId,
      argvHash: argvHash(input.args),
      policyHash: input.policyHash,
      ...(input.subjectRevision ? { subjectRevision: input.subjectRevision } : {}),
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
  via: 'human' | 'guardian'
  decisionRef?: DecisionHandle
  decidedAt: string
  answeredBy?: Actor
  subjectRevision?: string
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
    policyBinding: string
    approval?: import('@agnes/extension-api').ApprovalConstraints
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
    ...(input.approval ? { subjectRevision: input.approval.subjectRevision } : {}),
  })
  for (const { value } of s.state.registers.decisionStates.values()) {
    if (
      value.request.owner !== TOOL_DECISION_OWNER ||
      value.request.sourcePackage !== '@agnes/core' ||
      value.request.operationId !== input.toolUseId
    )
      continue
    const subject = value.request.spec.subject as {
      scope?: string
      bindingHash?: string
      policyVersion?: string
      policyBinding?: string
      approval?: { subjectRevision?: string }
    }
    if (subject.scope !== input.scope) continue
    if (value.request.requestedBy.id !== s.d.actor.id || value.request.requestedBy.org !== s.d.actor.org)
      throw new Error('DECISION_REQUESTER_CHANGED')
    if (
      subject.bindingHash !== expected ||
      subject.policyVersion !== input.policyVersion ||
      subject.policyBinding !== input.policyBinding
    )
      throw new Error('DECISION_SUBJECT_CHANGED')
    const snapshot = await s.decisions.get(value.handle)
    if (snapshot.invalidation || snapshot.result?.reason !== 'answered') return undefined
    if (snapshot.consumption) throw new Error('DECISION_ALREADY_CONSUMED')
    const option = snapshot.result.response.option
    if (!['allowed-once', 'allowed-session', 'allowed-permanent', 'rejected'].includes(option))
      throw new Error('DECISION_UNOFFERED_ANSWER')
    return {
      requestId: snapshot.handle.id,
      verdict: option as ApprovalVerdict,
      via: 'human',
      decisionRef: snapshot.handle,
      decidedAt: snapshot.result.at,
      answeredBy: snapshot.result.answeredBy,
      ...(subject.approval?.subjectRevision ? { subjectRevision: subject.approval.subjectRevision } : {}),
      ...(option === 'allowed-permanent'
        ? { grantId: permanentGrantId({ sessionKey: s.key, toolUseId: input.toolUseId, scope: input.scope }) }
        : {}),
    }
  }
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
    if (decision.via !== 'guardian') throw new Error('reset-required: obsolete tool approval record')
    if (input.approval && asked.approval?.subjectRevision !== input.approval.subjectRevision) continue
    const decidedRow = (await s.d.log.scan({ fromSeq: decision.seq, toSeq: decision.seq, lane: s.lane }))[0]
    if (decidedRow?.type !== 'approval/decided') continue
    if (
      decidedRow.origin !== 'system' ||
      decidedRow.trust !== 'trusted' ||
      decidedRow.actor.id !== s.d.actor.id ||
      decidedRow.actor.org !== s.d.actor.org
    )
      continue
    return {
      requestId,
      verdict: decision.verdict,
      via: 'guardian',
      decidedAt: decidedRow.ts,
      ...((decidedRow.data as { answeredBy?: Actor }).answeredBy
        ? { answeredBy: (decidedRow.data as { answeredBy: Actor }).answeredBy }
        : {}),
      ...(asked.approval ? { subjectRevision: asked.approval.subjectRevision } : {}),
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
  const old = await scanAll((query) => s.d.log.scan(query), {
    type: 'approval/asked',
    lane: s.lane,
    toSeq: s.lastSeq,
  })
  if (
    old.some((row) => {
      const asked = row.data as ApprovalAsked
      return (
        asked.kind === 'tool' &&
        !asked.scope?.startsWith('memory:') &&
        s.state.decisions.get(asked.requestId)?.via !== 'guardian'
      )
    })
  )
    throw new CoreError('E_RELATION', 'reset-required: obsolete tool approval record')
  for (const { value } of s.state.registers.decisionStates.values()) {
    if (
      value.request.owner !== TOOL_DECISION_OWNER ||
      value.request.sourcePackage !== '@agnes/core' ||
      value.request.lane !== s.lane ||
      value.request.requestedBy.id !== s.d.actor.id ||
      value.request.requestedBy.org !== s.d.actor.org ||
      !value.consumption ||
      value.invalidation ||
      value.result?.reason !== 'answered' ||
      value.result.response.option !== 'allowed-session'
    )
      continue
    const subject = value.request.spec.subject as {
      scope?: string
      bindingHash?: string
      call?: { name?: string; argsSeq?: number; policyHash?: string }
    }
    const call = s.state.toolCalls.get(value.request.operationId)
    if (
      !call ||
      call.lane !== s.lane ||
      call.seq !== subject.call?.argsSeq ||
      !subject.scope ||
      !subject.call.policyHash
    )
      continue
    const [row] = await s.d.log.scan({ fromSeq: call.seq, toSeq: call.seq, lane: s.lane })
    if (row?.type !== 'tool/call') continue
    const data = row.data as { name: string; args: unknown }
    if (
      subject.bindingHash !==
      approvalBindingHash({
        sessionKey: s.key,
        stepId: `${call.turn}/${call.step}`,
        toolUseId: value.request.operationId,
        args: data.args,
        policyHash: subject.call.policyHash,
        scope: subject.scope,
      })
    )
      continue
    s.sessionAllows.add(
      sessionGrantKey({ actor: s.d.actor, sessionKey: s.key, toolId: data.name, scope: subject.scope }),
    )
  }
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
    if (decision.via !== 'guardian') throw new Error('reset-required: obsolete tool approval record')
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
