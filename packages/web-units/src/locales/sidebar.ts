import type { LocaleCatalog } from './index.js'

/** 侧栏外壳的组件内文案（W2）。经 `SidebarDependencies.translate` 注入。 */
export const sidebarLocaleCatalog: LocaleCatalog = {
  en: {
    'sidebar.closeNav': 'Close navigation',
    'sidebar.newSession': 'New session',
    'sidebar.sectionHeading': 'Workspaces and sessions',
    'sidebar.addWorkspace': 'Add workspace',
    'sidebar.sessionsNav': 'Task list',
    'sidebar.settings': 'Settings',
    'sidebar.openNav': 'Open navigation',
  },
  'zh-CN': {
    'sidebar.closeNav': '关闭导航',
    'sidebar.newSession': '新会话',
    'sidebar.sectionHeading': '工作区与会话',
    'sidebar.addWorkspace': '添加工作区',
    'sidebar.sessionsNav': '任务列表',
    'sidebar.settings': '设置',
    'sidebar.openNav': '打开导航',
  },
}
