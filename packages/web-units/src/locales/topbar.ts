import type { LocaleCatalog } from './index.js'

/** 顶栏连接状态与默认占位。经组件 props 注入 translate。 */
export const topbarLocaleCatalog: LocaleCatalog = {
  en: {
    'topbar.connection.connecting': 'Connecting to the backend',
    'topbar.connection.connected': 'Local backend connected',
    'topbar.connection.reconnecting': 'Connection lost, reconnecting',
    'topbar.connection.closed': 'Backend connection closed',
    'topbar.defaultTitle': 'New session',
    'topbar.defaultStatus': 'Ready',
  },
  'zh-CN': {
    'topbar.connection.connecting': '正在连接后台',
    'topbar.connection.connected': '本地后台已连接',
    'topbar.connection.reconnecting': '连接中断，正在重连',
    'topbar.connection.closed': '后台连接已关闭',
    'topbar.defaultTitle': '新会话',
    'topbar.defaultStatus': '准备任务',
  },
}
