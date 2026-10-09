import type { LocaleCatalog } from '@agnes/web-ui'
import { knowledgeCatalog } from './locales/knowledge.js'
import { operationsCatalog } from './locales/operations.js'
import { providersCatalog } from './locales/providers.js'
import { securityCatalog } from './locales/security.js'
import { shellCatalog } from './locales/shell.js'

export const SETTINGS_NAMESPACE = '@agnes/web/runtime-settings'

export const settingsCatalog: LocaleCatalog = {
  en: {
    feedback: 'Feedback',
    ...shellCatalog.en,
    ...providersCatalog.en,
    ...knowledgeCatalog.en,
    ...operationsCatalog.en,
    ...securityCatalog.en,
  },
  'zh-CN': {
    feedback: '反馈',
    ...shellCatalog['zh-CN'],
    ...providersCatalog['zh-CN'],
    ...knowledgeCatalog['zh-CN'],
    ...operationsCatalog['zh-CN'],
    ...securityCatalog['zh-CN'],
  },
}
