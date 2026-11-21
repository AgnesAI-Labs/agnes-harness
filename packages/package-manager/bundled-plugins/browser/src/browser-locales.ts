const messages: Record<string, [string, string]> = {
  title: ['Browser', '浏览器'],
  sessionUnavailable: ['Pages appear when the conversation connects.', '会话连接后自动显示页面。'],
  preparing: ['Preparing browser…', '正在准备浏览器…'],
  unsupportedMacOS: [
    'The built-in browser requires macOS 13 Ventura or later. Update macOS to use it.',
    '内置浏览器需要 macOS 13 Ventura 或更高版本。请升级 macOS 后再使用。',
  ],
  unsupportedPlatform: [
    'The built-in browser supports Windows x64, macOS 13 or later, and Linux x64.',
    '内置浏览器支持 Windows x64、macOS 13 及以上版本和 Linux x64。',
  ],
  engineVersionMismatch: [
    'The installed browser engine is incompatible. Update Agnes Harness and try again.',
    '已安装的浏览器组件版本不兼容。请更新 Agnes Harness 后再试。',
  ],
  startupFailed: [
    'The built-in browser could not start. Turn it off and back on in Plugins, then try again.',
    '内置浏览器启动失败。请在「插件」页关闭后重新启用内置浏览器，再试一次。',
  ],
  cacheInvalid: [
    'Close AGH instances using this cache, move the revision folder aside, then re-enable the plugin.',
    '退出共用缓存的 AGH 实例，移开该版本目录，再启用插件。',
  ],
  cacheUnsafe: [
    'Use a private Linux cache without symlinks, then re-enable the plugin.',
    '请使用无符号链接的私有 Linux 缓存，再启用插件。',
  ],
  cleanupUnconfirmed: [
    'Browser cleanup could not be confirmed. Check the cleanup steps in Plugins before reopening it.',
    '无法确认浏览器已清理完成。请在「插件」页确认清理结果后再重新启用。',
  ],
  actionUnavailable: [
    'The browser action failed. Check the browser panel and try again.',
    '浏览器操作失败。请检查浏览器面板后重试。',
  ],
  actionStatusUnavailable: [
    'The browser could not confirm this action. Page status updates in the background.',
    '浏览器未确认这次操作。页面状态会在后台更新。',
  ],
  sessionIncompatible: [
    'This conversation uses an incompatible browser plugin version. Migrate it to the current plugin in Runtime settings, or open the page in a new conversation.',
    '此会话绑定的浏览器插件与当前版本不兼容。请在运行时设置中将会话迁移到当前插件，或新建会话打开网页。',
  ],
  accessDenied: [
    'This conversation cannot use the browser. Check the browser plugin and session permissions.',
    '此会话无法使用浏览器。请检查浏览器插件和会话权限。',
  ],
  capacity: [
    'The browser has reached its session or tab limit. Close an unused tab and try again.',
    '浏览器会话或标签页已达上限。请关闭不用的标签页后重试。',
  ],
  pageUnavailable: [
    'This browser page is closed. Open the address again.',
    '此浏览器页面已关闭。请重新打开网址。',
  ],
  lockHelp: ['Show installation lock recovery steps', '查看安装锁恢复步骤'],
  lockRecovery: [
    'Ask an administrator to inspect the lock path below. Legacy directory locks have no owner ID: stop every installer sharing this cache and verify none remain before moving the lock. Never remove a live lock. Restart this AGH instance and reopen the conversation. This button changes no files.',
    '请管理员检查下方锁路径。旧目录锁无所有者信息：先停止共用此缓存的全部安装进程，确认退出后再移开锁。禁止移除活跃锁。随后重启此 AGH 实例并重开会话。此按钮不修改文件。',
  ],
  copyRecovery: ['Copy steps and lock path', '复制步骤和锁路径'],
  copied: ['Copied', '已复制'],
  copyFailed: ['Copy failed. Select the steps and path above.', '复制失败，请手动选择上方步骤和路径。'],
  address: ['URL or file path on the AGH runtime', 'AGH 运行环境的网址或文件路径'],
  addressPlaceholder: ['Enter a website or workspace file path', '输入网址或工作区文件路径'],
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
  protectedTarget: [
    'AGH management and cloud metadata URLs are blocked.',
    '禁止访问 AGH 管理及云元数据地址。',
  ],
  invalidUrl: [
    'Enter a valid website address, such as www.example.com, or an authorized workspace file path.',
    '请输入有效的网址（如 www.example.com）或已授权的工作区文件路径。网址中不要包含账号密码。',
  ],
  fileDenied: [
    'The file is missing or inaccessible. Check the workspace file path.',
    '找不到文件，或当前会话无权访问。请检查工作区文件路径。',
  ],
  unsupportedFile: ['Unsupported file type.', '不支持此文件类型。'],
}

const catalog = (index: 0 | 1) =>
  Object.fromEntries(Object.entries(messages).map(([key, values]) => [`browser.${key}`, values[index]]))
export const browserCatalog = { en: catalog(0), 'zh-CN': catalog(1) }

const errorKeys: Record<string, string> = {
  GENERATION_STALE: 'sessionIncompatible',
  OUTCOME_UNKNOWN: 'actionStatusUnavailable',
  CAPABILITY_DENIED: 'accessDenied',
  UNSUPPORTED_MACOS: 'unsupportedMacOS',
  UNSUPPORTED_PLATFORM: 'unsupportedPlatform',
  VERSION_MISMATCH: 'engineVersionMismatch',
  LAUNCH_FAILED: 'startupFailed',
  CACHE_INVALID: 'cacheInvalid',
  CACHE_UNSAFE: 'cacheUnsafe',
  CLEANUP_UNCONFIRMED: 'cleanupUnconfirmed',
  PREPARING: 'preparing',
  CAPACITY: 'capacity',
  PAGE_UNAVAILABLE: 'pageUnavailable',
  PROTECTED_TARGET: 'protectedTarget',
  INVALID_URL: 'invalidUrl',
  FILE_DENIED: 'fileDenied',
  UNSUPPORTED_FILE: 'unsupportedFile',
}

export function browserErrorKey(code?: string | null): string | undefined {
  return code && Object.hasOwn(errorKeys, code) ? errorKeys[code] : undefined
}
