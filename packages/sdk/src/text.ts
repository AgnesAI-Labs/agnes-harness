export const TEXT = {
  en: {
    blocked: 'This request was blocked by the safety screen.',
    unavailable: 'Approval is unavailable right now, so the action was not performed.',
  },
  'zh-CN': {
    blocked: '该请求已被安全筛拦截。',
    unavailable: '当前无法完成审批，操作未执行。',
  },
} as const

export type Locale = keyof typeof TEXT
type Text = (typeof TEXT)[Locale]

export function textFor(locale: string): Text {
  return (TEXT as Readonly<Record<string, Text>>)[locale] ?? TEXT.en
}
