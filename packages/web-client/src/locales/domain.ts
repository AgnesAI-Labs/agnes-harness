import type { LocaleCatalog, LocaleVars } from '../services.js'

const en = {
  'domain.status': 'Status',
  'domain.phase.provisional': 'In progress',
  'domain.phase.finalized': 'Final',
  'domain.phase.interrupted': 'Interrupted, may be incomplete',
  'domain.phase.unknown': 'Unknown',
  'domain.unconfirmed': 'The request could not be confirmed.',
  'domain.unknownOutcome': 'The outcome is unknown. Check its status first.',
  'domain.refused': 'Refused: {message}',
  'domain.pending': 'Pending.',
  'domain.done': 'Done.',
  'domain.notAccepted': 'Not accepted.',
  'domain.cancelled': 'Cancelled.',
  'domain.failed': 'Failed: {message}',
  'domain.unavailable': 'Not available here.',
  'domain.sending': 'Sending.',
  'domain.retry': 'Retry {label}',
  'domain.checkStatus': 'Check status',
  'domain.resources': 'Resources',
} as const

const zh: Record<keyof typeof en, string> = {
  'domain.status': '状态',
  'domain.phase.provisional': '进行中',
  'domain.phase.finalized': '最终结果',
  'domain.phase.interrupted': '已中断，可能不完整',
  'domain.phase.unknown': '未知',
  'domain.unconfirmed': '无法确认请求是否已收到。',
  'domain.unknownOutcome': '结果未知，请先查询状态。',
  'domain.refused': '已拒绝：{message}',
  'domain.pending': '等待处理。',
  'domain.done': '已完成。',
  'domain.notAccepted': '未受理。',
  'domain.cancelled': '已取消。',
  'domain.failed': '失败：{message}',
  'domain.unavailable': '此处不可用。',
  'domain.sending': '正在发送。',
  'domain.retry': '重试 {label}',
  'domain.checkStatus': '查询状态',
  'domain.resources': '资源',
}

export const domainLocaleCatalog: LocaleCatalog = { en: { ...en }, 'zh-CN': { ...zh } }
export type DomainMessageKey = keyof typeof en

/** Built-in fallback copy follows the renderer's negotiated locale; business text stays as supplied. */
export function domainText(locale: string, key: DomainMessageKey, vars?: LocaleVars): string {
  const catalog = locale === 'zh-CN' ? zh : en
  return catalog[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    vars && Object.hasOwn(vars, name) ? String(vars[name]) : match,
  )
}
