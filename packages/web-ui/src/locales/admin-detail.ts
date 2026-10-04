import type { LocaleCatalog } from '../ui-locale.js'

export const ADMIN_DETAIL_LOCALE_NAMESPACE = '@agnes/web-ui/admin-detail'

export const adminDetailLocaleCatalog: LocaleCatalog = {
  en: {
    'close.aria': 'Close {heading} details',
    'close.label': 'Close details',
    'operations.recent': 'Recently completed operations',
    'operations.ongoing': 'Ongoing operations',
    'operations.retry': 'Backend allows retry',
    'operations.cancel': 'Request cancellation',
  },
  'zh-CN': {
    'close.aria': '关闭 {heading} 的详情',
    'close.label': '关闭详情',
    'operations.recent': '最近完成的操作',
    'operations.ongoing': '正在进行的操作',
    'operations.retry': '后台允许重试',
    'operations.cancel': '请求取消',
  },
}
