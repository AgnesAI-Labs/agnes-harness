import { createHash } from 'node:crypto'
import {
  defaultToolPolicy,
  type ProviderPluginContext,
  type ToolPolicy,
  toolPolicyKind,
} from '@agnes/extension-api'
import type { DecisionInput } from './domain.js'

/** Exact decision target and monotonic programme revision; the handler atomically checks that revision. */
export const decisionRevision = (input: DecisionInput) =>
  createHash('sha256')
    .update(JSON.stringify([input.kind, input.id, input.expectedRevision]))
    .digest('hex')

export const humanReviewPolicy: ToolPolicy = {
  id: 'aero-human-review',
  version: '1.0.0',
  decide(input, signal, ports) {
    signal.throwIfAborted()
    if (input.call.name === 'aero_report')
      return {
        effect: 'allow',
        reason:
          'Bounded evidence export under aero-output; no hardware or configuration mutation / 有界证据导出，不改变硬件或技术状态',
      }
    if (input.call.name !== 'aero_decide') return defaultToolPolicy.decide(input, signal, ports)
    const value = input.call.args
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !['mrb', 'configuration', 'rule', 'zeroing'].includes(String(value.kind)) ||
      typeof value.id !== 'string' ||
      !Number.isSafeInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 1
    )
      return { effect: 'deny', reason: 'Invalid quality decision / 无效质量决策' }
    return {
      effect: 'ask',
      reason: 'Human quality review of this target and programme revision / 人工审核当前对象与项目修订',
      approval: {
        reviewerRequirement: 'human',
        grantConstraints: 'once',
        subjectRevision: decisionRevision(value as DecisionInput),
      },
    }
  },
}

export const reviewPolicyPlugin = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register(toolPolicyKind, humanReviewPolicy)
  },
}
