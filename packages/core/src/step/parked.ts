import type { ExecutionDomain, ResolvedToolCallPolicy } from '@agnes/protocol'
import { scanAll } from '../log/scan-pages.js'
import type { ApprovalAsked } from '../reduce/shapes.js'
import {
  hasAuthenticToolPolicyHash,
  hasCompleteToolPolicyEnvelope,
  hasTrustedToolCallProvenance,
} from '../registry/tool-policy.js'
import { CoreError } from '../types.js'
import { approvalBindingHash } from './approval-grants.js'
import { newOpState, type OpStateObj, type ToolCallState } from './op-state.js'
import type { SessionImpl } from './session.js'
import { continueVerifier } from './verifier-continuation.js'

export async function approvalContinuation(
  s: SessionImpl,
): Promise<{ requestId: string; toolUseId: string } | undefined> {
  const op = s.op()
  if (!op) return undefined
  const start = (
    await s.d.log.scan({ fromSeq: op.meta.triggerSeq, toSeq: op.meta.triggerSeq, lane: s.lane })
  )[0]
  const data = start?.data as
    | { trigger?: string; continues?: { requestId?: string; toolUseId?: string } }
    | undefined
  const requestId = data?.continues?.requestId
  const toolUseId = data?.continues?.toolUseId
  return start?.type === 'turn/start' &&
    data?.trigger === 'approval-resume' &&
    typeof requestId === 'string' &&
    typeof toolUseId === 'string'
    ? { requestId, toolUseId }
    : undefined
}

/** A continuation's grant applies to its original call only, never to a later model call. */
export async function continuationAllows(
  s: SessionImpl,
  toolUseId: string,
  args: unknown,
  scope: string,
  policyHash: string,
): Promise<'allowed-once' | 'allowed-session' | 'allowed-permanent' | false> {
  const continuation = await approvalContinuation(s)
  if (!continuation || continuation.toolUseId !== toolUseId) return false
  const { requestId } = continuation
  const decision = s.state.decisions.get(requestId)
  const call = s.state.toolCalls.get(toolUseId)
  if (
    !decision?.verdict.startsWith('allowed') ||
    decision.lane !== s.lane ||
    !decision.askedSeq ||
    !call ||
    call.lane !== s.lane
  )
    return false
  const askedRow = (
    await s.d.log.scan({ fromSeq: decision.askedSeq, toSeq: decision.askedSeq, lane: s.lane })
  )[0]
  if (
    askedRow?.type !== 'approval/asked' ||
    askedRow.actor.id !== s.d.actor.id ||
    askedRow.actor.org !== s.d.actor.org
  )
    return false
  const asked = askedRow.data as ApprovalAsked
  if (asked.kind !== 'tool' || asked.toolUseId !== toolUseId || asked.scope !== scope) return false
  const binding = approvalBindingHash({
    sessionKey: s.key,
    stepId: `${call.turn}/${call.step}`,
    toolUseId,
    args,
    policyHash,
    scope,
  })
  if (!s.state.resumedRequests.has(requestId) || asked.bindingHash !== binding) return false
  if (decision.verdict === 'allowed-session' || decision.verdict === 'allowed-permanent')
    return decision.verdict
  return 'allowed-once'
}

/** Opens the single-call continuation. Multi-call batch policy remains explicitly pending. */
export async function continueParked(s: SessionImpl): Promise<'opened' | 'waiting' | 'blocked' | false> {
  if (s.op()) return false
  for (const [requestId, decision] of s.state.decisions) {
    if (decision.lane !== s.lane || decision.via === 'sync' || s.state.resumedRequests.has(requestId))
      continue
    if (!decision.askedSeq) throw new CoreError('E_RELATION', 'approval decision has no source request')
    const askedRow = (
      await s.d.log.scan({ fromSeq: decision.askedSeq, toSeq: decision.askedSeq, lane: s.lane })
    )[0]
    if (askedRow?.type !== 'approval/asked') throw new CoreError('E_RELATION', 'approval source missing')
    if (askedRow.actor.id !== s.d.actor.id || askedRow.actor.org !== s.d.actor.org) return 'waiting'
    const asked = askedRow.data as ApprovalAsked
    if (asked.kind === 'unknown-outcome' && !asked.toolUseId)
      return continueVerifier(s, requestId, askedRow.seq, decision.verdict.startsWith('allowed'))
    if (asked.kind !== 'tool' || !asked.toolUseId) continue
    const call = s.state.toolCalls.get(asked.toolUseId)
    if (!call || call.lane !== s.lane) throw new CoreError('E_RELATION', 'parked tool call missing')
    const turnStart = (
      await s.d.log.scan({
        fromSeq: 1,
        toSeq: call.seq,
        lane: s.lane,
        type: 'turn/start',
        order: 'desc',
        limit: 1,
      })
    )[0]
    if (!turnStart || (turnStart.data as { turn: number }).turn !== call.turn)
      throw new CoreError('E_RELATION', 'parked turn missing')
    const step = (
      await s.d.log.scan({
        fromSeq: turnStart.seq,
        toSeq: call.seq,
        lane: s.lane,
        type: 'step/start',
        order: 'desc',
        limit: 1,
      })
    )[0]
    if (!step || (step.data as { step: number }).step !== call.step)
      throw new CoreError('E_RELATION', 'parked step missing')
    const batch = await scanAll((q) => s.d.log.scan(q), {
      fromSeq: step.seq,
      toSeq: askedRow.seq,
      lane: s.lane,
      type: 'tool/call',
    })
    const row = batch.find(
      (candidate) =>
        candidate.seq === call.seq &&
        (candidate.data as { toolUseId?: unknown } | null)?.toolUseId === asked.toolUseId,
    )
    if (!row) throw new CoreError('E_RELATION', 'parked call mismatch')
    if (!hasTrustedToolCallProvenance(row)) return 'blocked'
    const original = row.data as {
      name: string
      ordinal: number
      depth?: number
      parentEffectId?: string
      resolvedPolicy?: ResolvedToolCallPolicy
      executionDomain?: ExecutionDomain
      definitionFingerprint?: string
      policyHash?: string
    }
    // Older open calls do not have enough durable policy to resume safely. Reclassifying them with
    // today's extension code would silently change the approval/replay decision the original turn
    // made, so leave the continuation blocked for operator recovery.
    if (!hasCompleteToolPolicyEnvelope(original) || !hasAuthenticToolPolicyHash(original)) return 'blocked'
    const persistedPolicy = {
      resolvedPolicy: original.resolvedPolicy,
      executionDomain: original.executionDomain,
      definitionFingerprint: original.definitionFingerprint,
      policyHash: original.policyHash,
    }
    const assistant = (
      await s.d.log.scan({
        fromSeq: step.seq,
        toSeq: call.seq,
        lane: s.lane,
        type: 'assistant/message',
        order: 'desc',
        limit: 1,
      })
    )[0]
    if (!assistant) throw new CoreError('E_RELATION', 'parked assistant missing')
    const allowed = decision.verdict.startsWith('allowed')
    const continuedCall: ToolCallState = allowed
      ? {
          ordinal: original.ordinal,
          toolUseId: asked.toolUseId,
          name: original.name,
          argsSeq: call.seq,
          status: 'planned',
          replay: persistedPolicy.resolvedPolicy.replay,
          ...(original.depth !== undefined ? { depth: original.depth } : {}),
          ...(original.parentEffectId !== undefined ? { parentEffectId: original.parentEffectId } : {}),
          ...persistedPolicy,
        }
      : {
          ordinal: original.ordinal,
          toolUseId: asked.toolUseId,
          name: original.name,
          argsSeq: call.seq,
          status: 'completed',
          replay: persistedPolicy.resolvedPolicy.replay,
          ...(original.depth !== undefined ? { depth: original.depth } : {}),
          ...(original.parentEffectId !== undefined ? { parentEffectId: original.parentEffectId } : {}),
          ...persistedPolicy,
        }
    const turn = s.lastTurnNumber() + 1
    const events = [
      s.ev('turn/start', {
        turn,
        trigger: 'approval-resume',
        continues: { turn: call.turn, step: call.step, toolUseId: asked.toolUseId, requestId },
      }),
      s.ev('step/start', { turn, step: 1 }),
    ]
    if (!allowed)
      events.push(
        s.ev(
          'tool/result',
          {
            toolUseId: asked.toolUseId,
            content: [{ type: 'text', text: `approval ${decision.verdict}` }],
            isError: true,
            code: 'APPROVAL_REJECTED',
            enforcement: s.d.runtime.enforcement(),
            authz: { decisionId: 'n/a' },
          },
          { sourceEventSeqs: [call.seq] },
        ),
      )
    await s.transition(events, (cur, seq) => {
      if (cur) throw new CoreError('E_LANE_BUSY', 'continuation lane occupied')
      const op = newOpState(
        {
          turn,
          lane: s.lane,
          acceptedAt: new Date(s.d.clock()).toISOString(),
          triggerSeq: seq,
          presetName: s.preset.name,
          profileHash: s.d.resolvedProfileHash,
          depthLimit: s.preset.depthLimit,
        },
        seq,
      )
      return {
        ...op,
        step: 1,
        latestAssistantSeq: assistant.seq,
        phase: {
          kind: 'tools',
          batch: {
            assistantSeq: assistant.seq,
            calls: [continuedCall],
          },
        },
      }
    })
    await s.rehydrateTurn(s.op() as OpStateObj)
    return 'opened'
  }
  return false
}
