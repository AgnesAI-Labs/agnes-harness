import type { LocaleCatalog } from '@agnes/web-ui'
export const SEARCH_NAMESPACE = '@agnes/web/search-settings'
export const searchCatalog: LocaleCatalog = {
  en: {
    add: 'Add search service',
    current: 'Currently using',
    default: 'Default service',
    settings: 'Settings',
    actions: 'Actions',
    advanced: 'Advanced options',
    cancel: 'Cancel',
    retry: 'Retry',
    emptyHelp: 'Choose a service and add its access key to let the agent search the web.',
    tested: 'Test passed',
    clearHelp: 'This service will lose access until you save another key.',
  },
  'zh-CN': {
    add: '添加搜索服务',
    current: '当前使用',
    default: '默认服务',
    settings: '设置',
    actions: '操作',
    advanced: '高级选项',
    cancel: '取消',
    retry: '重试',
    emptyHelp: '选择服务并保存访问密钥，让 Agent 能够搜索网页。',
    tested: '测试通过',
    clearHelp: '清除后，此服务将无法使用，直到你保存新的密钥。',
  },
}
