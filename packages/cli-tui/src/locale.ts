export const LOCALES = ['zh-CN', 'en'] as const

export const LOCALE_KEYS = [
  'approval.allowOnce',
  'approval.allowSession',
  'approval.allowPermanent',
  'approval.reject',
  'approval.waiting',
  'status.parked',
  'status.reconnecting',
  'status.catchingUp',
  'notice.resumed',
  'notice.crashed',
  'notice.closed',
  'permission.heading',
  'permission.toolRequest',
  'permission.resize',
  'permission.footer',
] as const

export type Locale = (typeof LOCALES)[number]
export type LocaleKey = (typeof LOCALE_KEYS)[number]

const DICT: Record<Locale, Record<LocaleKey, string>> = {
  en: {
    'approval.allowOnce': 'Allow once',
    'approval.allowSession': 'Allow for this session',
    'approval.allowPermanent': 'Always allow for this profile',
    'approval.reject': 'Reject',
    'approval.waiting': 'Awaiting approval',
    'status.parked': 'parked',
    'status.reconnecting': 'reconnecting',
    'status.catchingUp': 'catching up',
    'notice.resumed': 'stopped at step {step} last time, resumed',
    'notice.crashed': 'execution interrupted, auto-recovery within 30 s',
    'notice.closed': 'daemon connection closed; quit and run: agnes --resume {id}',
    'permission.heading': 'Approval',
    'permission.toolRequest': 'tool request',
    'permission.resize': 'Approval: resize or Esc reject',
    'permission.footer': 'Esc: reject · PgUp/PgDn details {start}-{end}/{total}',
  },
  'zh-CN': {
    'approval.allowOnce': '允许一次',
    'approval.allowSession': '本会话允许',
    'approval.allowPermanent': '对此配置始终允许',
    'approval.reject': '拒绝',
    'approval.waiting': '等待审批',
    'status.parked': '挂起',
    'status.reconnecting': '重连中',
    'status.catchingUp': '追赶中',
    'notice.resumed': '上次停在第 {step} 步，已续跑',
    'notice.crashed': '执行中断，30 秒内自动恢复',
    'notice.closed': '后台连接已关闭，请退出后运行：agnes --resume {id}',
    'permission.heading': '审批',
    'permission.toolRequest': '工具请求',
    'permission.resize': '审批：请调整窗口大小，或按 Esc 拒绝',
    'permission.footer': 'Esc：拒绝 · PgUp/PgDn 查看详情 {start}-{end}/{total}',
  },
}

export function resolveLocale(env: Readonly<Record<string, string | undefined>>): Locale {
  if (env.AGNES_LOCALE && (LOCALES as readonly string[]).includes(env.AGNES_LOCALE))
    return env.AGNES_LOCALE as Locale
  return (env.LANG ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export function t(
  key: LocaleKey,
  locale: string,
  vars: Readonly<Record<string, string | number>> = {},
): string {
  const dictionary = DICT[(LOCALES as readonly string[]).includes(locale) ? (locale as Locale) : 'en']
  return dictionary[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(vars[name] ?? `{${name}}`))
}
