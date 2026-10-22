import { newOpState, type OpStateObj, type ToolCallState } from '@agnes/core-common/step/op-state'
import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import { isNestedCall } from '@agnes/core-ledger'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { DecisionSnapshot } from '@agnes/extension-api'
import type { ExecutionDomain, ResolvedToolCallPolicy } from '@agnes/protocol'
import {
  hasAuthenticToolPolicyHash,
  hasCompleteToolPolicyEnvelope,
  hasTrustedToolCallProvenance,
} from '../../registry/tool-policy.js'
import { domainDecisionEvents, domainDecisionSource } from '../../step/domain-decision.js'
import type { SessionImpl } from '../../step/session.js'
import { nestedOutcomeNote, nestedParentName } from './nested-note.js'
import { TOOL_DECISION_OWNER, toolDecisionSource } from './tool-decision.js'

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

/**
 * The rows a continuation the user rejected, or whose approval expired, opens with: the call's
 * `APPROVAL_REJECTED` result and, for a nested call, its `[nested result]` note. No running code waits
 * on a nested call's refusal any more; the note is how the model hears of it.
 */
async function refusedRows(
  s: SessionImpl,
  original: { name: string; depth?: number; parentEffectId?: string },
  toolUseId: string,
  callSeq: Seq,
  rejected: boolean,
): Promise<EventInput[]> {
  const result = s.ev(
    'tool/result',
    {
      toolUseId,
      content: [
        {
          type: 'text',
          text: rejected
            ? 'the user rejected this action; do not retry the same call without asking'
            : 'approval unavailable: deadline',
        },
      ],
      isError: true,
      code: 'APPROVAL_REJECTED',
      enforcement: s.d.runtime.enforcement(),
      authz: { decisionId: 'n/a' },
    },
    { sourceEventSeqs: [callSeq] },
  )
  if (!isNestedCall(original)) return [result]
  const parent = await nestedParentName(s, original.parentEffectId)
  return [
    result,
    nestedOutcomeNote(s, { name: original.name, parent, outcome: rejected ? 'rejected' : 'deadline' }),
  ]
}

/** Opens the single-call continuation. Multi-call batch policy remains explicitly pending. */
export async function continueParked(s: SessionImpl): Promise<'opened' | 'waiting' | 'blocked' | false> {
  if (s.op()) return false
  for (const { value } of s.state.registers.decisionStates.values()) {
    if (
      !['core/unknown-outcome', 'core/budget'].includes(value.request.owner) ||
      value.request.lane !== s.lane ||
      value.request.sourcePackage !== '@agnes/core' ||
      value.consumption
    )
      continue
    if (value.request.requestedBy.id !== s.d.actor.id || value.request.requestedBy.org !== s.d.actor.org)
      continue
    const snapshot = await s.decisions.get(value.handle)
    if (!snapshot.result && !snapshot.invalidation) continue
    // The turn parked on "did it happen?" and the answer came afterwards: reopen that turn with the
    // answer, so the model carries on from it instead of waiting for the next user message.
    if (value.request.owner === 'core/unknown-outcome' && snapshot.result?.reason === 'answered')
      if (!snapshot.invalidation) return reopenAfterReconciliation(s, snapshot)
    if (snapshot.result?.reason === 'answered' && !snapshot.invalidation)
      await s.locked(async () => {
        await s.d.log.append([
          ...s.decisions.consumptionEvents(
            [snapshot.handle],
            domainDecisionSource(s, snapshot.request.spec.purpose, snapshot.request.operationId),
            null,
          ),
          s.ev(
            'x/core/decision-checkpoint',
            { handle: snapshot.handle, operationId: snapshot.request.operationId },
            { ignorable: true },
          ),
        ])
      })
  }
  for (const { value } of s.state.registers.decisionStates.values()) {
    if (
      value.request.owner !== TOOL_DECISION_OWNER ||
      value.request.sourcePackage !== '@agnes/core' ||
      value.request.lane !== s.lane ||
      value.consumption
    )
      continue
    const requestId = value.handle.id
    const toolUseId = value.request.operationId
    const call = s.state.toolCalls.get(toolUseId)
    if (!call || call.lane !== s.lane) throw new CoreError('E_RELATION', 'DECISION_CALL_MISSING')
    if (
      (
        await scanAll((query) => s.d.log.scan(query), {
          type: 'tool/result',
          lane: s.lane,
          fromSeq: call.seq,
          toSeq: s.lastSeq,
        })
      ).some((row) => (row.data as { toolUseId?: string }).toolUseId === toolUseId)
    )
      continue
    if (value.request.requestedBy.id !== s.d.actor.id || value.request.requestedBy.org !== s.d.actor.org)
      return 'waiting'
    const snapshot = await s.decisions.get(value.handle)
    if (
      !snapshot.result &&
      !snapshot.invalidation &&
      ((s.latest('inbox') as { items?: unknown[] } | undefined)?.items?.length ?? 0) > 0
    )
      return false
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
      toSeq: s.lastSeq,
      lane: s.lane,
      type: 'tool/call',
    })
    const row = batch.find(
      (candidate) =>
        candidate.seq === call.seq &&
        (candidate.data as { toolUseId?: unknown } | null)?.toolUseId === toolUseId,
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
        // Low-level drivers may schedule the model and tools in separate execution steps.
        fromSeq: turnStart.seq,
        toSeq: call.seq,
        lane: s.lane,
        type: 'assistant/message',
        order: 'desc',
        limit: 1,
      })
    )[0]
    // Deferred and independent Loops may call tools before the first model reply.
    // The original turn start bounds the batch scan when no model reply exists.
    const assistantSeq = assistant?.seq ?? turnStart.seq
    const allowed =
      !snapshot.invalidation &&
      (!snapshot.result ||
        (snapshot.result.reason === 'answered' && snapshot.result.response.option.startsWith('allow')))
    const continuedCall: ToolCallState = allowed
      ? {
          ordinal: original.ordinal,
          toolUseId: toolUseId,
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
          toolUseId: toolUseId,
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
        continues: { turn: call.turn, step: call.step, toolUseId: toolUseId, requestId },
      }),
      s.ev('step/start', { turn, step: 1 }),
    ]
    if (!allowed)
      events.push(
        ...(await refusedRows(s, original, toolUseId, call.seq, snapshot.result?.reason === 'answered')),
      )
    // A refusal is final: the answered decision ends with it, after the continuation that read it.
    if (snapshot.result?.reason === 'answered' && !allowed)
      events.push(
        ...domainDecisionEvents(
          s,
          snapshot,
          toolDecisionSource(s, {
            name: original.name,
            toolUseId,
            definitionFingerprint: original.definitionFingerprint,
          }),
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
        latestAssistantSeq: assistant?.seq ?? null,
        phase: {
          kind: 'tools',
          batch: {
            assistantSeq,
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

/**
 * Opens the continuation of a turn that parked on an unknown-outcome question once it is answered.
 * The start, the consumption and the note naming the answer commit together, so a restart either
 * sees the question still answered-and-open (and reopens here) or the continuation already running.
 * The never-replay call itself is not run again: its unknown result stays, and the note tells the
 * model which way the person settled it.
 */
async function reopenAfterReconciliation(s: SessionImpl, snapshot: DecisionSnapshot): Promise<'opened'> {
  const toolUseId = snapshot.request.operationId
  const call = s.state.toolCalls.get(toolUseId)
  if (!call || call.lane !== s.lane) throw new CoreError('E_RELATION', 'DECISION_CALL_MISSING')
  const name = (snapshot.request.spec.subject as { name?: unknown }).name
  const tool = typeof name === 'string' ? name : 'the call'
  const happened =
    snapshot.result?.reason === 'answered' && snapshot.result.response.option.startsWith('allow')
  const turn = s.lastTurnNumber() + 1
  await s.transition(
    () => [
      s.ev('turn/start', {
        turn,
        trigger: 'approval-resume',
        continues: { turn: call.turn, step: call.step, toolUseId, requestId: snapshot.handle.id },
      }),
      ...domainDecisionEvents(s, snapshot, domainDecisionSource(s, 'unknown-outcome', toolUseId)),
      s.ev('user/message', {
        content: [
          {
            type: 'text',
            text: happened
              ? `The outcome of ${tool} was unknown. The user confirmed that ${tool} happened; do not run it again.`
              : `The outcome of ${tool} was unknown. The user confirmed that ${tool} did not happen; check the current state before trying again.`,
          },
        ],
        kind: 'runtime_context',
      }),
    ],
    (cur, seq) => {
      if (cur) throw new CoreError('E_LANE_BUSY', 'continuation lane occupied')
      return newOpState(
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
    },
  )
  await s.rehydrateTurn(s.op() as OpStateObj)
  return 'opened'
}
