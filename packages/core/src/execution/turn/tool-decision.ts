import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError, type EventInput } from '@agnes/core-common/types'
import { isPending } from '@agnes/core-effects/effects/approval-answer'
import type { ApprovalRequest } from '@agnes/core-effects/effects/seams'
import type { DecisionSnapshot } from '@agnes/extension-api'
import { inspectJsonData, type JsonValue } from '@agnes/protocol'
import type { DecisionSource } from '../../step/decisions.js'
import type { SessionImpl } from '../../step/session.js'
import type { PlannedCall } from './tools.js'

export const TOOL_DECISION_OWNER = 'core/tool-permission'
export function toolDecisionSource(s: SessionImpl, call: PlannedCall): DecisionSource {
  const def = s.currentTools().resolve(call.name)
  if (!def || def.definitionFingerprint !== call.definitionFingerprint)
    throw new CoreError('E_RELATION', 'DECISION_SOURCE_CHANGED')
  const signal = s.ac.signal
  return s.decisions.bindSource({
    owner: TOOL_DECISION_OWNER,
    operationId: call.toolUseId,
    sourcePackage: '@agnes/core',
    packageVersion: s.d.agnesVersion ?? '0.0.0',
    alive() {
      if (s.currentTools().resolve(call.name)?.definitionFingerprint !== call.definitionFingerprint)
        throw new CoreError('E_RELATION', 'DECISION_SOURCE_CHANGED')
      signal.throwIfAborted()
    },
  })
}

/** Original call rows are immutable controlled content references, including oversized plans. */
export async function requestToolDecision(
  s: SessionImpl,
  call: PlannedCall,
  offered: ApprovalRequest,
): Promise<DecisionSnapshot> {
  const source = toolDecisionSource(s, call)
  const def = s.currentTools().resolve(call.name)
  if (!def || def.definitionFingerprint !== call.definitionFingerprint)
    throw new CoreError('E_RELATION', 'DECISION_SOURCE_CHANGED')
  const original = s.state.toolCalls.get(call.toolUseId)
  if (!original || original.seq !== call.argsSeq) throw new CoreError('E_RELATION', 'DECISION_CALL_MISSING')
  const args = inspectJsonData(call.args, 96000).ok
    ? (call.args as JsonValue)
    : { contentRef: { sessionId: s.key, seq: call.argsSeq, hash: sha256Hex(canonicalJson(call.args)) } }
  const handle = await s.decisions.port(source).request({
    key: `${call.toolUseId}:${offered.scope}`,
    purpose: call.name === 'exit_plan_mode' ? 'plan.exit' : 'tool.permission',
    subject: {
      call: {
        name: call.name,
        toolUseId: call.toolUseId,
        ordinal: call.ordinal,
        argsSeq: call.argsSeq,
        args,
        definitionFingerprint: call.definitionFingerprint,
        policyHash: call.policyHash,
        resolvedPolicy: call.resolvedPolicy,
        executionDomain: call.executionDomain,
      } as unknown as JsonValue,
      source: {
        owner: def.source.source,
        sourcePackage: def.packageIdentity ?? def.source.source,
        packageVersion: def.packageVersion ?? 'unversioned',
      },
      turn: original.turn,
      step: original.step,
      scope: offered.scope,
      policyVersion: offered.policyVersion ?? '',
      policyBinding: offered.policyBinding ?? '',
      profileHash: offered.profileHash ?? null,
      bindingHash: offered.bindingHash,
      approval: offered.approval ? { ...offered.approval } : null,
      context: offered.context ?? null,
      risk: offered.risk,
    },
    prompt: offered.summary,
    options: offered.options ?? ['allowed-once', 'allowed-session', 'rejected'],
    responseSchema: { type: 'null' },
  })
  return s.decisions.get(handle, source)
}

/** Delivery can end without an answer; the persisted request remains the only pending authority. */
export async function deliverToolDecision(
  s: SessionImpl,
  snapshot: DecisionSnapshot,
  offered: ApprovalRequest,
  signal: AbortSignal,
): Promise<{ snapshot: DecisionSnapshot; park?: EventInput }> {
  if (!snapshot.result && !snapshot.invalidation) {
    const local = new AbortController()
    const deliverySignal = AbortSignal.any([signal, local.signal])
    const delivery = s
      .askApprovalAnswer(
        {
          ...offered,
          requestId: snapshot.handle.id,
          deadline: snapshot.request.expiresAt ?? offered.deadline,
          decision: { handle: snapshot.handle, revision: snapshot.revision },
        },
        deliverySignal,
      )
      .then((answer) => ({ kind: 'delivery' as const, answer }))
    const source: DecisionSource = {
      owner: snapshot.request.owner,
      operationId: snapshot.request.operationId,
      sourcePackage: snapshot.request.sourcePackage,
      packageVersion: snapshot.request.packageVersion,
      alive() {},
    }
    const waiting = s.decisions
      .port(source)
      .wait(snapshot.handle, { signal: deliverySignal })
      .then((result) => ({ kind: 'state' as const, result }))
    let winner: Awaited<typeof delivery> | Awaited<typeof waiting>
    try {
      winner = await Promise.race([delivery, waiting])
    } finally {
      local.abort('detached')
      await Promise.allSettled([delivery, waiting])
    }
    signal.throwIfAborted()
    if (winner.kind === 'state') return { snapshot: await s.decisions.get(snapshot.handle) }
    const answer = winner.answer
    if (
      !isPending(answer) &&
      answer.answeredBy &&
      ['allowed-once', 'allowed-session', 'allowed-permanent', 'rejected'].includes(answer.verdict)
    ) {
      try {
        await s.decisions.answer(
          {
            handle: snapshot.handle,
            revision: snapshot.revision,
            commandId: `delivery:${snapshot.handle.id}`,
            response: { option: answer.verdict, value: null },
          },
          {
            actor: answer.answeredBy,
            category: 'human',
            authorize() {
              signal.throwIfAborted()
              const call = snapshot.request.spec.subject as {
                call?: { name?: string; definitionFingerprint?: string }
              }
              if (
                !call.call?.name ||
                s.currentTools().resolve(call.call.name)?.definitionFingerprint !==
                  call.call.definitionFingerprint
              )
                throw new CoreError('E_RELATION', 'DECISION_SOURCE_CHANGED')
            },
          },
        )
      } catch (error) {
        // Another authenticated client may have won the same writer race. Read its canonical result.
        const current = await s.decisions.get(snapshot.handle)
        if (!current.result && !current.invalidation) throw error
      }
    } else {
      const current = await s.decisions.get(snapshot.handle)
      if (!current.result && !current.invalidation)
        return {
          snapshot: current,
          park: s.ev(
            'x/core/decision-delivery',
            {
              handle: current.handle,
              waitEndedBy: isPending(answer)
                ? 'detached'
                : (answer.reason ?? (answer.answeredBy ? 'no-approver' : 'invalid-answer')),
            },
            { ignorable: true },
          ),
        }
    }
  }
  return { snapshot: await s.decisions.get(snapshot.handle) }
}
