import type { ToolPolicy, ToolPolicyPluginContext } from '@agnes/extension-api'
export const policy: ToolPolicy
export const plugin: { inject: string[]; apply(ctx: ToolPolicyPluginContext): void }
