const messages: Record<string, [string, string]> = {
  title: ['Browser', '浏览器'],
  sessionUnavailable: ['Pages appear when the conversation connects.', '会话连接后自动显示页面。'],
  pagesUnavailable: ['Pages unavailable. Reconnecting automatically.', '页面暂不可用，正在自动重连。'],
  preparing: ['Preparing browser…', '正在准备浏览器…'],
  lockHelp: ['Show installation lock recovery steps', '查看安装锁恢复步骤'],
  lockRecovery: [
    'Ask an administrator to inspect the lock path below. Legacy directory locks have no owner ID: stop every installer sharing this cache and verify none remain before moving the lock. Never remove a live lock. Restart this AGH instance and reopen the conversation. This button changes no files.',
    '请管理员检查下方锁路径。旧目录锁无所有者信息：先停止共用此缓存的全部安装进程，确认退出后再移开锁。禁止移除活跃锁。随后重启此 AGH 实例并重开会话。此按钮不修改文件。',
  ],
  copyRecovery: ['Copy steps and lock path', '复制步骤和锁路径'],
  copied: ['Copied', '已复制'],
  copyFailed: ['Copy failed. Select the steps and path above.', '复制失败，请手动选择上方步骤和路径。'],
  address: ['URL or file path on the AGH runtime', 'AGH 运行环境的网址或文件路径'],
  open: ['Open', '打开'],
  input: ['Type into the web page', '输入到网页'],
  inputHint: [
    'Click to type; page actions coordinate automatically. Escape returns to browser controls.',
    '点击即可输入，操作自动协调；Escape 返回浏览器控件。',
  ],
  pageChanged: [
    'Page changed during handover. Check it and click again.',
    '接管时页面已变化，请核对后重新点击。',
  ],
  more: ['Browser options', '浏览器选项'],
  screen: ['Live browser page', '浏览器实时页面'],
  tabs: ['Browser tabs', '浏览器标签页'],
  back: ['Back', '后退'],
  forward: ['Forward', '前进'],
  reload: ['Reload', '刷新'],
  connected: ['Live', '实时连接'],
  connecting: ['Connecting display…', '正在连接画面…'],
  connectingInput: ['Connecting page input…', '正在连接操作…'],
  fit: ['Fit to panel', '适应面板'],
  adaptiveViewport: ['Adapt page to panel', '页面随面板自适应'],
  fixedViewport: ['Use fixed desktop size (1280 × 800)', '固定桌面尺寸（1280 × 800）'],
  actualSize: ['Show at 100%', '按 100% 显示'],
  disconnected: ['Display disconnected', '画面连接已断开'],
  noSession: ['Open a conversation first.', '请先打开会话。'],
  empty: [
    'No open pages. AGH opens them as needed, or enter a URL or workspace file path above.',
    '暂无页面。AGH 按需打开；也可在上方输入网址或工作区文件路径。',
  ],
  reconnect: ['Reconnect display', '重连画面'],
  close: ['Close tab', '关闭标签页'],
  events: ['Recent page errors', '最近页面错误'],
  noErrors: ['No recent errors.', '暂无错误。'],
  checkAction: ['Check previous action', '核对上次操作'],
  protectedTarget: [
    'AGH management and cloud metadata URLs are blocked.',
    '禁止访问 AGH 管理及云元数据地址。',
  ],
  invalidUrl: [
    'Use http(s) without credentials, or an authorized workspace file path.',
    '请输入无账号密码的 http(s) 网址或已授权的工作区文件路径。',
  ],
  fileDenied: ['File unavailable or outside the preview directory.', '文件不可用或超出预览目录。'],
  unsupportedFile: ['Unsupported file type.', '不支持此文件类型。'],
}

const catalog = (index: 0 | 1) =>
  Object.fromEntries(Object.entries(messages).map(([key, values]) => [`browser.${key}`, values[index]]))
export const browserCatalog = { en: catalog(0), 'zh-CN': catalog(1) }
