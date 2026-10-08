import { createPluginTestRegistration } from '@agnes/host/testkit/plugin-registration'
import { providedExternalModules } from '@agnes/plugin-runtime/provided-externals'
import * as testkit from '@agnes/plugin-runtime/testkit'

/** Public author namespaces with the production registration bridge included in the release. */
export const namespaces = {
  ...providedExternalModules,
  '@agnes/plugin-runtime/testkit': {
    ...testkit,
    createPluginTestHost: (
      plugin: Parameters<typeof testkit.createPluginTestHost>[0],
      options: testkit.PluginTestOptions = {},
    ) =>
      testkit.createPluginTestHost(plugin, {
        ...options,
        registration: options.registration ?? createPluginTestRegistration(),
      }),
  },
}
