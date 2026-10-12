import type { LocaleCatalog } from '@agnes/web-ui'
import { settingsShellLocaleCatalog } from '@agnes/web-units/locales/settings-shell'
import { knowledgeCatalog } from './locales/knowledge.js'
import { operationsCatalog } from './locales/operations.js'
import { providersCatalog } from './locales/providers.js'
import { securityCatalog } from './locales/security.js'
import { shellCatalog } from './locales/shell.js'

export const SETTINGS_NAMESPACE = '@agnes/web/runtime-settings'

export const settingsCatalog: LocaleCatalog = {
  en: {
    ...settingsShellLocaleCatalog.en,
    feedback: 'Feedback',
    ...shellCatalog.en,
    ...providersCatalog.en,
    ...knowledgeCatalog.en,
    ...operationsCatalog.en,
    ...securityCatalog.en,
  },
  'zh-CN': {
    ...settingsShellLocaleCatalog['zh-CN'],
    feedback: '反馈',
    ...shellCatalog['zh-CN'],
    ...providersCatalog['zh-CN'],
    ...knowledgeCatalog['zh-CN'],
    ...operationsCatalog['zh-CN'],
    ...securityCatalog['zh-CN'],
  },
}
