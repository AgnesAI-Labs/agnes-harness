import type { LocaleCatalog } from './index.js'

/** 顶栏连接状态与默认占位。经组件 props 注入 translate。 */
export const topbarLocaleCatalog: LocaleCatalog = {
  en: {
    'topbar.connection.connecting': 'Connecting to the backend',
    'topbar.connection.connected': 'Local backend connected',
    'topbar.connection.reconnecting': 'Connection lost, reconnecting',
    'topbar.connection.closed': 'Backend connection closed',
    'topbar.rename': 'Rename session',
    'topbar.rename.name': 'Session name',
    'topbar.rename.save': 'Save session name',
    'topbar.rename.cancel': 'Cancel renaming',
    'topbar.rename.invalid': 'Enter a session name.',
    'topbar.rename.failed': 'The session name could not be saved. Try again.',
    'topbar.agent': 'Agent: {name}',
    'topbar.stop': 'Stop',
    'topbar.defaultTitle': 'New session',
    'topbar.defaultStatus': 'Ready',
  },
  'zh-CN': {
    'topbar.connection.connecting': '正在连接后台',
    'topbar.connection.connected': '本地后台已连接',
    'topbar.connection.reconnecting': '连接中断，正在重连',
    'topbar.connection.closed': '后台连接已关闭',
    'topbar.rename': '重命名会话',
    'topbar.rename.name': '会话名称',
    'topbar.rename.save': '保存会话名称',
    'topbar.rename.cancel': '取消改名',
    'topbar.rename.invalid': '请输入会话名称。',
    'topbar.rename.failed': '会话名称保存失败，请重试。',
    'topbar.agent': 'Agent：{name}',
    'topbar.stop': '停止',
    'topbar.defaultTitle': '新会话',
    'topbar.defaultStatus': '准备任务',
  },
}
