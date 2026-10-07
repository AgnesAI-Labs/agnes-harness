import type { Context } from '@agnes/cordis'
import type { LoopRegistryPort, ModelAdapterRegistration, PluginExtensionAPI } from '@agnes/extension-api'

export type LoopPluginContext = Context & { loops: LoopRegistryPort }
export type ModelAdapterPluginContext = Context & { modelAdapters: ModelAdapterRegistration }

declare module '@agnes/cordis' {
  interface Context {
    /** Available only to Host-mounted plugin rows with extension injection. */
    extension(): PluginExtensionAPI
  }
}
