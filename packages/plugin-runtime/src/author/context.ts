import type { PluginExtensionAPI, ToolRegistrationPort } from '@agnes/extension-api'

declare module '@agnes/cordis' {
  interface Context {
    /** Available to Host-mounted plugin rows with extension injection. */
    extension(): PluginExtensionAPI
    /** Registration and cleanup belong to the calling plugin fiber. */
    tools: ToolRegistrationPort
  }
}
