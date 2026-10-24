import type { Locale } from './locale.js'

/** Strings of /heads-up and the heads-up note, kept beside the other locale files so locale-extended.ts stays small. */
export type HeadsUpKey =
  | 'commands.headsUp'
  | 'commands.headsUpSummary'
  | 'headsUp.usage'
  | 'headsUp.on'
  | 'headsUp.off'
  | 'headsUp.unsupported'
  | 'headsUp.label'

export const HEADS_UP_DICT: Record<Locale, Record<HeadsUpKey, string>> = {
  en: {
    'commands.headsUp':
      'Let a side model review the agent work and hand it an advisory heads-up (off by default; costs extra model calls)',
    'commands.headsUpSummary': 'Side-review heads-ups',
    'headsUp.usage': 'Usage: /heads-up [on|off]',
    'headsUp.on':
      'Heads-up is on for this session: after side-effecting tool calls and at the end of each turn, the conversation so far plus a truncated tool summary is sent to the verifier model, or the fast model when no verifier is set.',
    'headsUp.off': 'Heads-up is off for this session',
    'headsUp.unsupported': 'Heads-up is not available in this session',
    'headsUp.label': 'Heads-up',
  },
  'zh-CN': {
    'commands.headsUp': '让旁路模型审查 agent 的工作并递上一条仅供参考的提醒（默认关闭，会多花模型调用）',
    'commands.headsUpSummary': '旁路提醒',
    'headsUp.usage': '用法：/heads-up [on|off]',
    'headsUp.on':
      '本会话已开启旁路提醒：在有副作用的工具调用之后和每轮结束时，会把到目前为止的对话和截断后的工具摘要发给验证模型，没有验证模型时发给快速模型。',
    'headsUp.off': '本会话已关闭旁路提醒',
    'headsUp.unsupported': '本会话不支持旁路提醒',
    'headsUp.label': '旁路提醒',
  },
}
