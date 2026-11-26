import { bindModelAdapterExternal } from '@agnes/ai'
import { bindProvidedContractModules } from '@agnes/base/provided-contracts'
import * as authorTestkit from '@agnes/host/author-testkit'
import { createPluginTestRegistration } from '@agnes/host/testkit/plugin-registration'
import { providedExternalModules, registerProvidedExternal } from '@agnes/plugin-runtime/provided-externals'
import * as testkit from '@agnes/plugin-runtime/testkit'
import * as clientTestkit from '@agnes/web-client/testkit'
import { React } from '@agnes/web-client/testkit'

bindProvidedContractModules()
bindModelAdapterExternal(registerProvidedExternal)

const reactNamespace: typeof React & { default: typeof React } = { ...React, default: React }

/** Public author namespaces and the explicit production registration bridge. */
export const namespaces = {
  ...providedExternalModules,
  react: reactNamespace,
  '@agnes/web-client/testkit': clientTestkit,
  '@agnes/plugin-runtime/testkit': testkit,
  '@agnes/host/testkit': { createPluginTestRegistration },
  '@agnes/host/author-testkit': authorTestkit,
}
