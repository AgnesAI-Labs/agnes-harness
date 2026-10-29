import {
  defaultToolPolicy,
  type ProviderPluginContext,
  type ToolPolicy,
  type ToolPolicyInput,
  toolPolicyKind,
} from '@agnes/extension-api'
import { decidePlanState, type PlanModeReader } from '../../../src/plan-mode-contract.js'
import { sandboxToolPolicies } from '../../sandbox/src/tool-policies.js'
import { createAutoReviewPolicy } from './auto-review.js'
import { selectAutoReviewSettings } from './settings.js'

// These shipped tools defer execution to the daemon's mandatory exact-hash card. Taint
// belongs on that human decision too; it must not introduce a second ordinary tool card.
function candidateTest(input: ToolPolicyInput): boolean {
  if (input.policy.requiresApproval !== 'never') return false
  const args = input.call.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  return input.call.name === 'plugin_test'
    ? typeof args.candidateId === 'string' && /^candidate-[a-f0-9]{32}$/.test(args.candidateId)
    : ['plugin_helper_install', 'skill_helper_install'].includes(input.call.name) &&
        args.action === 'test' &&
        typeof args.proposalId === 'string' &&
        /^candidate-[a-f0-9]{32}$/.test(args.proposalId)
}

/** Plan mode sits in front of every shipped policy, including full-access. The fallback still owns
 * risk, taint, and preset denial. Human prompts and durable tickets stay on the approval seam. */
function withPlanMode(policy: ToolPolicy, reader?: () => PlanModeReader | undefined): ToolPolicy {
  return {
    ...policy,
    id: policy.id,
    version: policy.version,
    decide(input, signal, ports) {
      return decidePlanState(
        reader?.(),
        candidateTest(input) ? { ...input, tainted: false } : input,
        signal,
        policy,
        ports,
      )
    },
  }
}

export const toolPolicy = { ...withPlanMode(defaultToolPolicy), settings: selectAutoReviewSettings }
export const toolPolicyPlugin = {
  inject: { providers: null, planMode: { required: false } },
  apply(ctx: ProviderPluginContext & { readonly planMode?: PlanModeReader }) {
    const read = () => ctx.planMode
    const selected = { ...withPlanMode(defaultToolPolicy, read), settings: selectAutoReviewSettings }
    ctx.providers.register(toolPolicyKind, selected)
    ctx.providers.register(toolPolicyKind, createAutoReviewPolicy(selected))
    for (const policy of sandboxToolPolicies)
      ctx.providers.register(toolPolicyKind, withPlanMode(policy, read))
  },
}
