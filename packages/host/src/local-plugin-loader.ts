import * as pluginRuntime from '@agnes/plugin-runtime'

/** Share author helpers with local source graphs outside the Host node_modules tree. */
export const localPluginVirtualModules = {
  '@agnes/plugin-runtime': pluginRuntime,
} as const
