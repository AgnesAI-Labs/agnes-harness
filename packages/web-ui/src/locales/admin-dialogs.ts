import type { LocaleCatalog } from '../ui-locale.js'

export const ADMIN_DIALOGS_LOCALE_NAMESPACE = '@agnes/web-ui/admin-dialogs'

export const adminDialogsLocaleCatalog: LocaleCatalog = {
  en: {
    'source.kicker': 'Source',
    'source.type': 'Source type',
    'source.reference': 'Source reference',
    'source.checking': 'Checking…',
    'source.check': 'Check source',
    'confirmation.kicker': 'Confirmation',
    cancel: 'Cancel',
  },
  'zh-CN': {
    'source.kicker': '来源',
    'source.type': '来源类型',
    'source.reference': '来源引用',
    'source.checking': '正在检查…',
    'source.check': '检查来源',
    'confirmation.kicker': '确认',
    cancel: '取消',
  },
}
