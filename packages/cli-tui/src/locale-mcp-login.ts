import type { Locale } from './locale.js'

/** Strings of `/mcp login` and `/mcp logout`: a locale file of their own so locale-extended.ts stays small. */
export type McpLoginKey =
  | 'mcpLogin.unavailable'
  | 'mcpLogin.none'
  | 'mcpLogin.loadFailed'
  | 'mcpLogin.usageLogin'
  | 'mcpLogin.usageLogout'
  | 'mcpLogin.pickTitle'
  | 'mcpLogin.title'
  | 'mcpLogin.starting'
  | 'mcpLogin.waiting'
  | 'mcpLogin.pasteLabel'
  | 'mcpLogin.pasteHint'
  | 'mcpLogin.copy'
  | 'mcpLogin.cancel'
  | 'mcpLogin.signedIn'
  | 'mcpLogin.alreadySignedIn'
  | 'mcpLogin.cancelled'
  | 'mcpLogin.timedOut'
  | 'mcpLogin.reconnectFailed'
  | 'mcpLogin.loggedOut'

export const MCP_LOGIN_DICT: Record<Locale, Record<McpLoginKey, string>> = {
  en: {
    'mcpLogin.unavailable': 'This session cannot sign in to MCP servers.',
    'mcpLogin.none': 'No MCP server needs sign-in.',
    'mcpLogin.loadFailed': 'Could not list the MCP servers. {error}',
    'mcpLogin.usageLogin': 'usage: /mcp login [server]',
    'mcpLogin.usageLogout': 'usage: /mcp logout <server>',
    'mcpLogin.pickTitle': 'Sign in to an MCP server',
    'mcpLogin.title': 'Sign in to {server}',
    'mcpLogin.starting': 'Starting the sign-in…',
    'mcpLogin.waiting':
      'Finish the sign-in in your browser. If the browser is on another machine, paste the address it ends on below.',
    'mcpLogin.pasteLabel': 'Address:',
    'mcpLogin.pasteHint': 'an empty line cancels',
    'mcpLogin.copy': 'copy address',
    'mcpLogin.cancel': 'cancel',
    'mcpLogin.signedIn': 'Signed in to {server}.',
    'mcpLogin.alreadySignedIn': 'Already signed in to {server}.',
    'mcpLogin.cancelled': 'Sign-in cancelled.',
    'mcpLogin.timedOut': 'Sign-in timed out after 5 minutes.',
    'mcpLogin.reconnectFailed':
      'The sign-in is saved, but reconnecting {server} failed: {error}. Run /mcp status {server} to see why.',
    'mcpLogin.loggedOut': 'Signed out of {server}.',
  },
  'zh-CN': {
    'mcpLogin.unavailable': '当前会话无法登录 MCP 服务。',
    'mcpLogin.none': '没有需要登录的 MCP 服务。',
    'mcpLogin.loadFailed': '无法列出 MCP 服务。{error}',
    'mcpLogin.usageLogin': '用法：/mcp login [服务]',
    'mcpLogin.usageLogout': '用法：/mcp logout <服务>',
    'mcpLogin.pickTitle': '登录 MCP 服务',
    'mcpLogin.title': '登录 {server}',
    'mcpLogin.starting': '正在开始登录…',
    'mcpLogin.waiting': '请在浏览器里完成登录。如果浏览器在另一台机器上，把它最后跳转到的网址粘贴到下面。',
    'mcpLogin.pasteLabel': '网址：',
    'mcpLogin.pasteHint': '空行取消',
    'mcpLogin.copy': '复制网址',
    'mcpLogin.cancel': '取消',
    'mcpLogin.signedIn': '已登录 {server}。',
    'mcpLogin.alreadySignedIn': '{server} 已登录。',
    'mcpLogin.cancelled': '已取消登录。',
    'mcpLogin.timedOut': '登录超时（5 分钟）。',
    'mcpLogin.reconnectFailed':
      '登录已保存，但重新连接 {server} 失败：{error}。运行 /mcp status {server} 查看原因。',
    'mcpLogin.loggedOut': '已登出 {server}。',
  },
}
