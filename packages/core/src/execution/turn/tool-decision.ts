import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import { APPROVAL_RESPONSE_SCHEMA } from '@agnes/core-effects/effects/approval-answer'
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

/** The server a `mcp__<server>__<tool>` name was registered for, as the stable (sanitized) id. */
const mcpServerOf = (name: string): string | undefined => /^mcp__(.+?)__./.exec(name)?.[1]

/** The one-line reason a card gives when it offers only a single approval. */
const configGuardPresentation = (summary: string) => {
  const title = summary.slice(0, 1024) || 'Approval'
  return {
    en: {
      title,
      fields: [
        {
          label: 'Note',
          value:
            'This is an agh configuration or instruction file; it can only be approved one call at a time.',
        },
      ],
    },
    'zh-CN': {
      title,
      fields: [{ label: '说明', value: '这是 agh 的配置或指令文件，只能逐次批准。' }],
    },
  }
}

/** Original call rows are immutable controlled content references, including oversized plans. */
export async function requestToolDecision(
  s: SessionImpl,
  call: PlannedCall,
  offered: ApprovalRequest,
  rewrite?: AskRewrite,
  facts: { grantScopes?: readonly string[] | undefined; configGuarded?: boolean } = {},
): Promise<DecisionSnapshot> {
  const { grantScopes, configGuarded } = facts
  const source = toolDecisionSource(s, call)
  const mcpServer = mcpServerOf(call.name)
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
      ...(offered.prefixGrant ? { prefixGrant: offered.prefixGrant } : {}),
      ...(rewrite ? { rewrite } : {}),
      // Display facts for the card: what an always-allow would store and who asked.
      ...(grantScopes?.length ? { grantScopes: [...grantScopes] } : {}),
      origin: {
        package: def.packageIdentity ?? def.source.source,
        ...(s.d.roleDelegation ? { role: String(s.d.roleDelegation.role.ref) } : {}),
        ...(mcpServer ? { mcpServer } : {}),
      },
    },
    prompt: offered.summary,
    ...(configGuarded ? { presentation: configGuardPresentation(offered.summary) } : {}),
    options: offered.options ?? ['allowed-once', 'allowed-session', 'rejected'],
    responseSchema: APPROVAL_RESPONSE_SCHEMA,
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
