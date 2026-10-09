import {
  defaultToolPolicy,
  registerToolPolicyPlugin,
  type ToolPolicy,
  type ToolPolicyPluginContext,
} from '@agnes/extension-api'
import { decidePlanMode } from '../../plan-mode/src/policy.js'
import { sandboxToolPolicies } from '../../sandbox/src/tool-policies.js'
import { createAutoReviewPolicy } from './auto-review.js'
import { selectAutoReviewSettings } from './settings.js'

/** Plan mode sits in front of every shipped policy, including full-access. The fallback still owns
 * risk, taint, and preset denial. Human prompts and durable tickets stay on the approval seam. */
function withPlanMode(policy: ToolPolicy): ToolPolicy {
  return {
    ...policy,
    id: policy.id,
    version: policy.version,
    decide(input, signal, ports) {
      return decidePlanMode(input, signal, policy, ports)
    },
  }
}

export const toolPolicy = { ...withPlanMode(defaultToolPolicy), settings: selectAutoReviewSettings }
export const toolPolicyPlugin = {
  inject: ['toolPolicies'],
  apply(ctx: ToolPolicyPluginContext) {
    registerToolPolicyPlugin(ctx, '@agnes/base', toolPolicy)
    registerToolPolicyPlugin(ctx, '@agnes/base', createAutoReviewPolicy(toolPolicy))
    for (const policy of sandboxToolPolicies)
      registerToolPolicyPlugin(ctx, '@agnes/base', withPlanMode(policy))
  },
}
