import type { LocaleCatalog } from '@agnes/web-ui'
import { candidatesCatalog } from './admin/candidates.js'
import { runtimeCatalog } from './admin/runtime.js'
import { trustCatalog } from './admin/trust.js'
import { operationsCatalog } from './admin/operations.js'
import { pluginAdminShellLocaleCatalog } from './shell.js'

export const PLUGIN_ADMIN_LOCALE_NAMESPACE = '@agnes/web/plugin-admin'

export const pluginAdminLocaleCatalog: LocaleCatalog = {
  en: {
    ...candidatesCatalog.en,
    ...runtimeCatalog.en,
    ...trustCatalog.en,
    ...operationsCatalog.en,
    ...pluginAdminShellLocaleCatalog.en,
  },
  'zh-CN': {
    ...candidatesCatalog['zh-CN'],
    ...runtimeCatalog['zh-CN'],
    ...trustCatalog['zh-CN'],
    ...operationsCatalog['zh-CN'],
    ...pluginAdminShellLocaleCatalog['zh-CN'],
  },
}
