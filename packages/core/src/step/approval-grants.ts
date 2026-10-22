import { parsePrefixScope } from '@agnes/core-common/command-table/prefix'
import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { argvHash } from '@agnes/core-effects/effects/runtime'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { DecisionHandle } from '@agnes/extension-api'
import type { Actor, ApprovalGrant, ApprovalVerdict } from '@agnes/protocol'
import { TOOL_DECISION_OWNER } from '../execution/turn/tool-decision.js'
import type { SessionImpl } from './session.js'

export type ApprovalGrantBinding = {
  actor: Pick<Actor, 'id' | 'org'>
  policyDigest: string
  toolId: string
  scope: string
  policyVersion: string
  definitionFingerprint: string
  policyBinding: string
}

export const sessionGrantKey = (input: {
  actor: Pick<Actor, 'id' | 'org'>
  sessionKey: string
  toolId: string
  scope: string
  definitionFingerprint: string
  policyBinding: string
}): string => sha256Hex(canonicalJson(input))

/** Answers that leave a session-wide allowance behind. */
export const isSessionGrantOption = (option: unknown): boolean =>
  option === 'allowed-session' || option === 'allow_prefix_session'

/**
 * The scope a session-wide answer granted: the request's own scope for a whole-tool allowance, the
 * offered command prefix for a prefix allowance. A prefix answer without a well-formed offer grants nothing.
 */
export function grantedSessionScope(option: unknown, subject: unknown): string | undefined {
  const facts = subject as { scope?: unknown; prefixGrant?: { tokens?: unknown; scope?: unknown } } | null
  if (option === 'allow_prefix_session') {
    const scope = facts?.prefixGrant?.scope
    const tokens = typeof scope === 'string' ? parsePrefixScope(scope) : undefined
    return tokens && JSON.stringify(tokens) === JSON.stringify(facts?.prefixGrant?.tokens)
      ? (scope as string)
      : undefined
  }
  return option === 'allowed-session' && typeof facts?.scope === 'string' ? facts.scope : undefined
}

export function approvalScopesForCall(toolId: string, scopes: readonly string[]): string[] {
  const ordered = [...new Set(scopes)]
  return ordered.length > 0 ? ordered : [`tool:${toolId}:execute`]
}

export function permanentGrantMatches(grant: ApprovalGrant, binding: ApprovalGrantBinding): boolean {
  return (
    grant.revokedAt === undefined &&
    grant.policyDigest === binding.policyDigest &&
    grant.actorId === binding.actor.id &&
    grant.actorOrg === binding.actor.org &&
    grant.toolId === binding.toolId &&
    grant.scope === binding.scope &&
    grant.policyVersion === binding.policyVersion &&
    grant.definitionFingerprint === binding.definitionFingerprint &&
    grant.policyBinding === binding.policyBinding
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
  verdict: ApprovalVerdict | 'allow_prefix_session'
  grantId?: string
  decisionRef?: DecisionHandle
  decidedAt: string
  answeredBy?: Actor
  subjectRevision?: string
  /** Set for a prefix answer: the scope of the prefix that was offered and accepted. */
  prefixScope?: string | undefined
}

/**
 * Finds a decision already durably bound to this exact call and scope. This is the common crash
 * recovery path for synchronous and callback decisions: once the ledger says what was decided,
 * no caller is asked a second time.
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
    if (
      !['allowed-once', 'allowed-session', 'allowed-permanent', 'allow_prefix_session', 'rejected'].includes(
        option,
      )
    )
      throw new Error('DECISION_UNOFFERED_ANSWER')
    return {
      requestId: snapshot.handle.id,
      verdict: option as ApprovalVerdict | 'allow_prefix_session',
      decisionRef: snapshot.handle,
      decidedAt: snapshot.result.at,
      answeredBy: snapshot.result.answeredBy,
      ...(subject.approval?.subjectRevision ? { subjectRevision: subject.approval.subjectRevision } : {}),
      ...(option === 'allow_prefix_session'
        ? { prefixScope: grantedSessionScope(option, value.request.spec.subject) }
        : {}),
      ...(option === 'allowed-permanent'
        ? { grantId: permanentGrantId({ sessionKey: s.key, toolUseId: input.toolUseId, scope: input.scope }) }
        : {}),
    }
  }
  return undefined
}

export function newPermanentGrant(
  input: ApprovalGrantBinding & {
    grantId: string
    createdAt: string
    sourceDecisionId: string
    issuer: Actor | undefined
  },
): ApprovalGrant {
  if (!input.issuer || input.issuer.role === 'agent') throw new Error('DECISION_GRANT_ISSUER_INVALID')
  return {
    grantId: input.grantId,
    policyDigest: input.policyDigest,
    actorId: input.actor.id,
    actorOrg: input.actor.org,
    toolId: input.toolId,
    scope: input.scope,
    policyVersion: input.policyVersion,
    createdAt: input.createdAt,
    sourceDecisionId: input.sourceDecisionId,
    issuer: input.issuer,
    definitionFingerprint: input.definitionFingerprint,
    policyBinding: input.policyBinding,
  }
}

/** Restores only grants whose original identity and argument binding can still be proved. */
export async function restoreSessionGrants(s: SessionImpl): Promise<void> {
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
      !isSessionGrantOption(value.result.response.option)
    )
      continue
    const granted = grantedSessionScope(value.result.response.option, value.request.spec.subject)
    if (!granted) continue
    const subject = value.request.spec.subject as {
      scope?: string
      bindingHash?: string
      policyBinding?: string
      call?: { name?: string; argsSeq?: number; policyHash?: string; definitionFingerprint?: string }
    }
    const call = s.state.toolCalls.get(value.request.operationId)
    if (
      !call ||
      call.lane !== s.lane ||
      call.seq !== subject.call?.argsSeq ||
      !subject.scope ||
      !subject.call.policyHash ||
      !subject.call.definitionFingerprint ||
      !subject.policyBinding
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
    if (granted !== subject.scope) s.sessionPrefixScopes.add(granted)
    s.sessionAllows.add(
      sessionGrantKey({
        actor: s.d.actor,
        sessionKey: s.key,
        toolId: data.name,
        scope: granted,
        definitionFingerprint: subject.call.definitionFingerprint,
        policyBinding: subject.policyBinding,
      }),
    )
  }
}

/** A session-wide allowance as a person can read it; `grantId` is the decision that granted it. */
export type SessionGrantEntry = {
  grantId: string
  toolId: string
  scope: string
  createdAt: string
  issuer?: Actor
}

/** The allowances in force, each with the key Core checks before asking again. */
function activeSessionGrants(s: SessionImpl): Array<{ key: string; entry: SessionGrantEntry }> {
  const active: Array<{ key: string; entry: SessionGrantEntry }> = []
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
      !isSessionGrantOption(value.result.response.option)
    )
      continue
    const granted = grantedSessionScope(value.result.response.option, value.request.spec.subject)
    const subject = value.request.spec.subject as {
      scope?: string
      policyBinding?: string
      call?: { name?: string; definitionFingerprint?: string }
    }
    if (!granted || !subject.policyBinding || !subject.call?.name || !subject.call.definitionFingerprint)
      continue
    const key = sessionGrantKey({
      actor: s.d.actor,
      sessionKey: s.key,
      toolId: subject.call.name,
      scope: granted,
      definitionFingerprint: subject.call.definitionFingerprint,
      policyBinding: subject.policyBinding,
    })
    // Only what is actually honoured: a record this session could not restore is not a grant.
    if (!s.sessionAllows.has(key)) continue
    active.push({
      key,
      entry: {
        grantId: value.handle.id,
        toolId: subject.call.name,
        scope: granted,
        createdAt: value.result.at,
        ...(value.result.answeredBy ? { issuer: value.result.answeredBy } : {}),
      },
    })
  }
  return active
}

export function listSessionGrants(s: SessionImpl): SessionGrantEntry[] {
  return activeSessionGrants(s).map(({ entry }) => structuredClone(entry))
}

/** Durable: the revoked decision is skipped when a reopened session restores its allowances. */
export async function revokeSessionGrant(s: SessionImpl, grantId: string): Promise<boolean> {
  const active = activeSessionGrants(s)
  const target = active.find(({ entry }) => entry.grantId === grantId)
  if (!target || !(await s.decisions.revokeSessionGrant(grantId))) return false
  // The same tool and scope may have been allowed again by a later decision; that one still stands.
  if (!active.some(({ key, entry }) => key === target.key && entry.grantId !== grantId))
    s.sessionAllows.delete(target.key)
  return true
}
