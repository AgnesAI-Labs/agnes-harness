import { defaultToolPolicy } from '@agnes/core'
import { registerToolPolicyPlugin, type ToolPolicyPluginContext } from '@agnes/extension-api'

/** Same risk/taint/full-access decisions as the existing approval extension. Human prompts,
 * command-table rules and durable tickets continue through its approval seam. */
export const toolPolicy = defaultToolPolicy
export const toolPolicyPlugin = {
  inject: ['toolPolicies'],
  apply(ctx: ToolPolicyPluginContext) {
    registerToolPolicyPlugin(ctx, '@agnes/base', toolPolicy)
  },
}
