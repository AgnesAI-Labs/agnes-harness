import {
  defaultToolPolicy,
  type ProviderPluginContext,
  type ToolPolicy,
  toolPolicyKind,
} from '@agnes/extension-api'
import { decidePlanState, type PlanModeReader } from '../../../src/plan-mode-contract.js'
import { sandboxToolPolicies } from '../../sandbox/src/tool-policies.js'
import { createAutoReviewPolicy } from './auto-review.js'
import { selectAutoReviewSettings } from './settings.js'

/** Plan mode sits in front of every shipped policy, including full-access. The fallback still owns
 * risk, taint, and preset denial. Human prompts and durable tickets stay on the approval seam. */
function withPlanMode(policy: ToolPolicy, reader?: () => PlanModeReader | undefined): ToolPolicy {
  return {
    ...policy,
    id: policy.id,
    version: policy.version,
    decide(input, signal, ports) {
      return decidePlanState(reader?.(), input, signal, policy, ports)
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
