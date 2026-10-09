/** JSON Schema 2020-12, with local references only. */
export type PluginConfigSchema = boolean | Readonly<Record<string, unknown>>
export type PluginConfigReload = 'live' | 'next-session'
export const DEFAULT_PLUGIN_CONFIG_RELOAD: PluginConfigReload = 'next-session'
export interface PluginConfigContract {
  readonly configSchema?: PluginConfigSchema
  readonly configReload?: PluginConfigReload
}
export type PluginConfigIssue = Readonly<{ path: string; code: string }>

/** Validation implementation belongs to the protocol package shared by runtime consumers. */
export { compilePluginConfig, redactPluginConfig, PLUGIN_SECRET_REF_PATTERN } from '@agnes/protocol'
