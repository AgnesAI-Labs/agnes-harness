import type {
  PluginEventLogPort,
  PluginHooksPort,
  PluginProjectionsPort,
  PluginResourcesPort,
  PluginServicesPort,
  PluginSlotsPort,
  ToolRegistrationPort,
} from '@agnes/extension-api'

declare module '@agnes/cordis' {
  interface Context {
    /** Registration and cleanup belong to the calling plugin fiber. */
    tools: ToolRegistrationPort
    hooks: PluginHooksPort
    projections: PluginProjectionsPort
    services: PluginServicesPort
    slots: PluginSlotsPort
    resources: PluginResourcesPort
    eventLog: PluginEventLogPort
    /** Identity, trust tier, logger, abort signal and platform facts of the calling plugin. */
    self: import('@agnes/extension-api').ExtensionContext
  }
}
