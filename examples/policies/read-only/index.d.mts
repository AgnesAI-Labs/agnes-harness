import type { ProviderPluginContext, ToolPolicy } from '@agnes/extension-api'
export const policy: ToolPolicy
export const plugin: { inject: string[]; apply(ctx: ProviderPluginContext): void }
