export const LOCALES = ['zh-CN', 'en'] as const

export const LOCALE_KEYS = [
  'approval.allowOnce',
  'approval.allowSession',
  'approval.allowPermanent',
  'approval.allowPrefix',
  'approval.projectCode',
  'approval.reject',
  'approval.rejectReason',
  'approval.from',
  'approval.role',
  'approval.mcp',
  'approval.stores',
  'approval.fullAccessBusiness',
  'status.parked',
  'status.fullAccess',
  'status.preset',
  'status.reconnecting',
  'status.safeMode',
  'status.catchingUp',
  'notice.resumed',
  'notice.crashed',
  'notice.streamLost',
  'notice.closed',
  'permission.candidateTest',
  'permission.toolRequest',
  'permission.resize',
] as const

export type Locale = (typeof LOCALES)[number]
export type LocaleKey = (typeof LOCALE_KEYS)[number]

const DICT: Record<Locale, Record<LocaleKey, string>> = {
  en: {
    'approval.allowOnce': 'Allow once',
    'approval.allowSession': 'Allow for this session',
    'approval.allowPermanent': 'Always allow for this profile',
    'approval.projectCode':
      'This also runs scripts defined in the project (package scripts, git hooks, build code).',
    'approval.allowPrefix': 'Allow commands starting with {prefix} for this session',
    'approval.reject': 'Reject',
    'approval.rejectReason': 'Reject with a reason',
    'approval.from': 'from {value}',
    'approval.role': 'role {value}',
    'approval.mcp': 'MCP server {value}',
    'approval.stores': 'Always allow stores: {value}',
    'approval.fullAccessBusiness': 'auto-confirmed under full access',
    'status.parked': 'parked',
    'status.fullAccess': '⚠ full access',
    'status.preset': 'preset',
    'status.reconnecting': 'reconnecting',
    'status.safeMode': 'safe mode',
    'status.catchingUp': 'catching up',
    'notice.resumed': 'stopped at step {step} last time, resumed',
    'notice.crashed': 'execution interrupted, auto-recovery within 30 s',
    'notice.streamLost': 'live updates stopped; use /resume to reopen this session',
    'notice.closed': 'daemon connection closed; quit and run: agh --resume {id}',
    'permission.candidateTest':
      'Run the candidate’s Node author tests on this machine: {name} ({hash}). This does not publish, trust or enable anything. Review the source in Settings → Plugins → Candidates before running.',
    'permission.toolRequest': 'tool request',
    'permission.resize': 'Approval: resize or Esc reject',
  },
  'zh-CN': {
    'approval.allowOnce': '允许一次',
    'approval.allowSession': '本会话允许',
    'approval.allowPermanent': '对此配置始终允许',
    'approval.projectCode': '这也会运行项目定义的脚本（包脚本、git hooks、构建代码）。',
    'approval.allowPrefix': '本会话内以 {prefix} 开头的命令不再询问',
    'approval.reject': '拒绝',
    'approval.rejectReason': '拒绝并说明理由',
    'approval.from': '来自 {value}',
    'approval.role': '角色 {value}',
    'approval.mcp': 'MCP 服务 {value}',
    'approval.stores': '始终允许会存入：{value}',
    'approval.fullAccessBusiness': '完全访问下自动确认',
    'status.parked': '挂起',
    'status.fullAccess': '⚠ 完全访问',
    'status.preset': '预设',
    'status.reconnecting': '重连中',
    'status.safeMode': '安全模式',
    'status.catchingUp': '追赶中',
    'notice.resumed': '上次停在第 {step} 步，已续跑',
    'notice.crashed': '执行中断，30 秒内自动恢复',
    'notice.streamLost': '实时更新已中断，请用 /resume 重新打开本会话',
    'notice.closed': '后台连接已关闭，请退出后运行：agh --resume {id}',
    'permission.candidateTest':
      '在本机运行候选的 Node 作者测试：{name}（{hash}）。测试不会发布、信任或启用任何内容。运行前请到「设置 → 插件 → 候选」审阅源码。',
    'permission.toolRequest': '工具请求',
    'permission.resize': '审批：请调整窗口大小，或按 Esc 拒绝',
  },
}

/**
 * One language for the TUI, print and error help: the first non-empty of AGNES_LOCALE, LC_ALL,
 * LC_MESSAGES and LANG decides, and anything starting with `zh` is Simplified Chinese.
 */
export function resolveLocale(env: Readonly<Record<string, string | undefined>>): Locale {
  const value = env.AGNES_LOCALE || env.LC_ALL || env.LC_MESSAGES || env.LANG
  return value?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export function t(
  key: LocaleKey,
  locale: string,
  vars: Readonly<Record<string, string | number>> = {},
): string {
  const dictionary = DICT[(LOCALES as readonly string[]).includes(locale) ? (locale as Locale) : 'en']
  return dictionary[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(vars[name] ?? `{${name}}`))
}

/** Daemon/SDK notice kinds that get a status-bar rendering; anything else is left alone rather than guessed at. */
export const NOTICE_STATUS: ReadonlyMap<string, readonly [LocaleKey, 'success' | 'error']> = new Map([
  ['resumed', ['notice.resumed', 'success']],
  ['worker_crashed', ['notice.crashed', 'error']],
  ['stream-recovery-failed', ['notice.streamLost', 'error']],
])
