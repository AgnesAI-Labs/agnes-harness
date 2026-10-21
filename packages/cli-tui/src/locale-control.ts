import type { Locale } from './locale.js'

/**
 * Strings of the tool-detail, child-agent, job and queue surfaces. They live beside locale-extended.ts
 * (which merges them into `tt`) so that file stays under the source-size limit.
 */
export const CONTROL_KEYS = ['tool.detail.loading', 'tool.detail.failed'] as const

export type ControlKey = (typeof CONTROL_KEYS)[number]

export const CONTROL_DICT: Record<Locale, Record<ControlKey, string>> = {
  en: {
    'tool.detail.loading': 'Loading the full record…',
    'tool.detail.failed': 'Full record unavailable ({reason}); showing the preview.',
  },
  'zh-CN': {
    'tool.detail.loading': '正在读取完整记录…',
    'tool.detail.failed': '无法读取完整记录（{reason}），显示的是预览。',
  },
}
