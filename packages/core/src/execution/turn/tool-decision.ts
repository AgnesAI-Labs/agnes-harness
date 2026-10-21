import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import type { ApprovalRequest } from '@agnes/core-effects/effects/seams'
import type { DecisionHandle, DecisionSnapshot } from '@agnes/extension-api'
import { inspectJsonData, type JsonValue } from '@agnes/protocol'
import { childLifecycle } from '../../child/lifecycle.js'
import type { AskRewrite } from '../../step/approval-ask.js'
import type { DecisionSource } from '../../step/decisions.js'
import type { SessionImpl } from '../../step/session.js'
import type { PlannedCall } from './tools.js'

export const TOOL_DECISION_OWNER = 'core/tool-permission'
export function toolDecisionSource(
  s: SessionImpl,
  call: Pick<PlannedCall, 'name' | 'toolUseId' | 'definitionFingerprint'>,
  admitting = false,
): DecisionSource {
  const def = s.currentTools().resolve(call.name)
  if (!def || def.definitionFingerprint !== call.definitionFingerprint)
    throw new CoreError('E_RELATION', 'DECISION_SOURCE_CHANGED')
  const signal = s.ac.signal
  const lifecycle = childLifecycle(s)
  return s.decisions.bindSource({
    permission: true,
    owner: TOOL_DECISION_OWNER,
    operationId: call.toolUseId,
    sourcePackage: '@agnes/core',
    packageVersion: s.d.agnesVersion ?? '0.0.0',
    alive() {
      lifecycle.assertActive()
      if (admitting && s.roleAuthority && !lifecycle.hasParent)
        throw new CoreError('E_CLOSED', 'Delegated effect requires a live owning session')
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
  rewrite?: AskRewrite,
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
      ...(rewrite ? { rewrite } : {}),
    },
    prompt: offered.summary,
    options: offered.options ?? ['allowed-once', 'allowed-session', 'rejected'],
    responseSchema: { type: 'null' },
  })
  return s.decisions.get(handle, source)
}

export { deliverDecision as deliverToolDecision } from '../../step/decision-delivery.js'

/**
 * Consumption and its checkpoint for decisions that were answered but will never back an effect,
 * for the caller to append beside the call's refusal. Decisions already consumed, invalidated or
 * past their deadline are left to their own terminal state.
 */
export function settledDecisionEvents(
  s: SessionImpl,
  handles: readonly DecisionHandle[],
  source: DecisionSource,
) {
  return handles.flatMap((handle) => {
    try {
      return [
        ...s.decisions.consumptionEvents([handle], source, null),
        s.ev('x/core/decision-checkpoint', { handle, operationId: source.operationId }, { ignorable: true }),
      ]
    } catch {
      return []
    }
  })
}
