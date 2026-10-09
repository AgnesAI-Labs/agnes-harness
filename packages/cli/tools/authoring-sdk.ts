import { createPluginTestRegistration } from '@agnes/host/testkit/plugin-registration'
import { providedExternalModules } from '@agnes/plugin-runtime/provided-externals'
import * as testkit from '@agnes/plugin-runtime/testkit'

/** Public author namespaces and the explicit production registration bridge. */
export const namespaces = {
  ...providedExternalModules,
  '@agnes/plugin-runtime/testkit': testkit,
  '@agnes/host/testkit': { createPluginTestRegistration },
}
