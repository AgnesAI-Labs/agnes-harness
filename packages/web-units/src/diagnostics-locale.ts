export const DIAGNOSTICS_LOCALES = ['en', 'zh-CN'] as const
export type DiagnosticsLocale = (typeof DIAGNOSTICS_LOCALES)[number]

const en = {
  'diagnostics.title.menu': 'Report a problem',
  'diagnostics.title.share': 'Choose what to include',
  'diagnostics.title.ready': 'Diagnostics package is ready',
  'diagnostics.title.saved': 'Diagnostics file saved',
  'diagnostics.intro':
    'Create a diagnostics ZIP you can share with support. It can include this session’s conversation and trace, logs, and system information.',
  'diagnostics.redaction': 'Secrets are redacted before sharing.',
  'diagnostics.cancel': 'Cancel',
  'diagnostics.share': 'Share diagnostics',
  'diagnostics.include.conversation': 'Conversation and trace',
  'diagnostics.include.logs': 'Logs',
  'diagnostics.include.system': 'System information',
  'diagnostics.back': 'Back',
  'diagnostics.generate': 'Generate package',
  'diagnostics.generating': 'Generating…',
  'diagnostics.warning':
    'Some diagnostics were unavailable or over the export limit. See diagnostic-export-warnings.json in the package.',
  'diagnostics.save': 'Save ZIP',
  'diagnostics.savedIntro': 'Share this ZIP with support or engineering. Unzip it and open index.html.',
  'diagnostics.close': 'Close',
  'diagnostics.error.generate': 'Could not generate the diagnostics package: {detail}',
  'diagnostics.error.save': 'Could not save the diagnostics package: {detail}',
  'diagnostics.savedPartial': 'The package was exported, but some material is incomplete',
  'diagnostics.viewer.title': 'agh diagnostics package',
  'diagnostics.viewer.fallbackTitle': 'Application scope',
  'diagnostics.viewer.meta': 'Version {version} · exported {createdAt}',
  'diagnostics.viewer.tab.overview': 'Overview',
  'diagnostics.viewer.tab.conversation': 'Conversation',
  'diagnostics.viewer.tab.trace': 'Trace',
  'diagnostics.viewer.tab.logs': 'Logs',
  'diagnostics.viewer.tab.system': 'System',
  'diagnostics.viewer.tab.artifacts': 'Artifacts',
  'diagnostics.viewer.notIncluded': 'Not included',
  'diagnostics.viewer.included': 'Included',
  'diagnostics.viewer.excluded': 'Not included',
  'diagnostics.viewer.events': 'The full event ledger is events.jsonl ({count} records, through seq {seq})',
  'diagnostics.viewer.duration.running': 'In progress',
  'diagnostics.viewer.duration.ms': '{n} ms',
  'diagnostics.viewer.duration.seconds': '{n} s',
  'diagnostics.viewer.duration.minutes': '{minutes} min {seconds} s',
  'diagnostics.viewer.status.running': 'In progress',
  'diagnostics.viewer.status.waiting': 'Waiting',
  'diagnostics.viewer.status.completed': 'Completed',
  'diagnostics.viewer.status.failed': 'Failed',
  'diagnostics.viewer.status.cancelled': 'Cancelled',
  'diagnostics.viewer.reason.unavailable': 'Unavailable',
  'diagnostics.viewer.reason.truncated': 'Truncated',
  'diagnostics.viewer.reason.limit': 'Over the limit',
  'diagnostics.viewer.reason.timeout': 'Timed out',
  'diagnostics.viewer.reason.failed': 'Failed',
  'diagnostics.viewer.reason.imported': 'Imported',
  'diagnostics.viewer.error': 'Error: {message}',
  'diagnostics.viewer.turn': 'Turn {turn}',
  'diagnostics.viewer.truncated': '…(truncated)',
  'diagnostics.viewer.warning': '{source}: {reason}',
  'diagnostics.viewer.warningDetail': '{source}: {reason} ({detail})',
  'diagnostics.viewer.toolSummary': '{name}: {summary}',
  'diagnostics.trace.window':
    'Only the {n} most recently loaded nodes are included. Earlier history is not included.',
} as const

const zh: Record<keyof typeof en, string> = {
  'diagnostics.title.menu': '报告问题',
  'diagnostics.title.share': '选择要包含的内容',
  'diagnostics.title.ready': '诊断包已生成',
  'diagnostics.title.saved': '诊断文件已保存',
  'diagnostics.intro':
    '创建一个可分享给支持人员的诊断 ZIP 包，可以包含当前会话的对话与轨迹、日志和系统信息。',
  'diagnostics.redaction': '分享前会先对密钥脱敏。',
  'diagnostics.cancel': '取消',
  'diagnostics.share': '分享诊断',
  'diagnostics.include.conversation': '对话与轨迹',
  'diagnostics.include.logs': '日志',
  'diagnostics.include.system': '系统信息',
  'diagnostics.back': '返回',
  'diagnostics.generate': '生成诊断包',
  'diagnostics.generating': '正在生成…',
  'diagnostics.warning': '部分诊断资料不可用或超出导出上限，详见包内 diagnostic-export-warnings.json。',
  'diagnostics.save': '保存 ZIP 包',
  'diagnostics.savedIntro': '把这个 ZIP 包分享给支持或研发人员。解压后打开 index.html 查看。',
  'diagnostics.close': '关闭',
  'diagnostics.error.generate': '生成诊断包失败：{detail}',
  'diagnostics.error.save': '保存诊断包失败：{detail}',
  'diagnostics.savedPartial': '诊断包已导出，部分资料不完整',
  'diagnostics.viewer.title': 'agh 诊断包',
  'diagnostics.viewer.fallbackTitle': '应用范围',
  'diagnostics.viewer.meta': '版本 {version} · 导出于 {createdAt}',
  'diagnostics.viewer.tab.overview': '概览',
  'diagnostics.viewer.tab.conversation': '对话',
  'diagnostics.viewer.tab.trace': '轨迹',
  'diagnostics.viewer.tab.logs': '日志',
  'diagnostics.viewer.tab.system': '系统',
  'diagnostics.viewer.tab.artifacts': '产物',
  'diagnostics.viewer.notIncluded': '未包含',
  'diagnostics.viewer.included': '已包含',
  'diagnostics.viewer.excluded': '未包含',
  'diagnostics.viewer.events': '完整事件账本见 events.jsonl（{count} 条，截至 seq {seq}）',
  'diagnostics.viewer.duration.running': '进行中',
  'diagnostics.viewer.duration.ms': '{n} 毫秒',
  'diagnostics.viewer.duration.seconds': '{n} 秒',
  'diagnostics.viewer.duration.minutes': '{minutes} 分 {seconds} 秒',
  'diagnostics.viewer.status.running': '进行中',
  'diagnostics.viewer.status.waiting': '等待中',
  'diagnostics.viewer.status.completed': '已完成',
  'diagnostics.viewer.status.failed': '失败',
  'diagnostics.viewer.status.cancelled': '已取消',
  'diagnostics.viewer.reason.unavailable': '不可用',
  'diagnostics.viewer.reason.truncated': '已截断',
  'diagnostics.viewer.reason.limit': '超出上限',
  'diagnostics.viewer.reason.timeout': '超时',
  'diagnostics.viewer.reason.failed': '失败',
  'diagnostics.viewer.reason.imported': '导入',
  'diagnostics.viewer.error': '错误：{message}',
  'diagnostics.viewer.turn': '第 {turn} 轮',
  'diagnostics.viewer.truncated': '…（已截断）',
  'diagnostics.viewer.warning': '{source}：{reason}',
  'diagnostics.viewer.warningDetail': '{source}：{reason}（{detail}）',
  'diagnostics.viewer.toolSummary': '{name}：{summary}',
  'diagnostics.trace.window': '仅含已加载的最近 {n} 个节点，更早的历史未包含',
}

export const diagnosticsCatalog = { en: { ...en }, 'zh-CN': { ...zh } }

export function diagnosticsLocale(): DiagnosticsLocale {
  if (typeof document !== 'undefined' && document.documentElement?.lang === 'zh-CN') return 'zh-CN'
  return 'en'
}

export function diagnosticsText(
  key: keyof typeof en,
  vars?: Readonly<Record<string, string | number>>,
  locale: DiagnosticsLocale = diagnosticsLocale(),
): string {
  const template = diagnosticsCatalog[locale][key] ?? diagnosticsCatalog.en[key]
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  )
}

export function diagnosticsViewerLabels(locale: DiagnosticsLocale = diagnosticsLocale()) {
  const text = (key: keyof typeof en, vars?: Readonly<Record<string, string | number>>) =>
    diagnosticsText(key, vars, locale)
  return {
    notIncluded: text('diagnostics.viewer.notIncluded'),
    included: text('diagnostics.viewer.included'),
    excluded: text('diagnostics.viewer.excluded'),
    durationRunning: text('diagnostics.viewer.duration.running'),
    durationMs: text('diagnostics.viewer.duration.ms'),
    durationSeconds: text('diagnostics.viewer.duration.seconds'),
    durationMinutes: text('diagnostics.viewer.duration.minutes'),
    status: {
      running: text('diagnostics.viewer.status.running'),
      waiting: text('diagnostics.viewer.status.waiting'),
      completed: text('diagnostics.viewer.status.completed'),
      failed: text('diagnostics.viewer.status.failed'),
      cancelled: text('diagnostics.viewer.status.cancelled'),
    },
    reason: {
      unavailable: text('diagnostics.viewer.reason.unavailable'),
      truncated: text('diagnostics.viewer.reason.truncated'),
      limit: text('diagnostics.viewer.reason.limit'),
      timeout: text('diagnostics.viewer.reason.timeout'),
      failed: text('diagnostics.viewer.reason.failed'),
      imported: text('diagnostics.viewer.reason.imported'),
    },
    include: {
      conversation: text('diagnostics.include.conversation'),
      logs: text('diagnostics.include.logs'),
      system: text('diagnostics.include.system'),
    },
    error: text('diagnostics.viewer.error'),
    turn: text('diagnostics.viewer.turn'),
    events: text('diagnostics.viewer.events'),
    truncated: text('diagnostics.viewer.truncated'),
    warning: text('diagnostics.viewer.warning'),
    warningDetail: text('diagnostics.viewer.warningDetail'),
    toolSummary: text('diagnostics.viewer.toolSummary'),
  }
}
