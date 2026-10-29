import type { Locale } from './locale.js'

/** Strings of /handoff: kept beside the other locale files so locale-extended.ts stays small. */
export type HandoffKey =
  | 'commands.handoff'
  | 'commands.handoffSummary'
  | 'handoff.busy'
  | 'handoff.working'
  | 'handoff.title'
  | 'handoff.hint'
  | 'handoff.sent'
  | 'handoff.titlePrefix'
  | 'handoff.intro'

export const HANDOFF_DICT: Record<Locale, Record<HandoffKey, string>> = {
  en: {
    'commands.handoff':
      'Summarise this session with one model call, then continue in a fresh session that starts from the summary',
    'commands.handoffSummary': 'Hand off to a fresh session',
    'handoff.busy': 'A turn is running: wait for it to finish or Ctrl-C before /handoff.',
    'handoff.working': 'Summarising the session for the handoff…',
    'handoff.title': 'Handoff summary',
    'handoff.hint': 'open a new session',
    'handoff.sent': 'Handed off from {id}; /resume {id} goes back',
    'handoff.titlePrefix': 'Handoff: ',
    'handoff.intro': 'Context handed off from session {id}:',
  },
  'zh-CN': {
    'commands.handoff': '用一次模型调用总结当前会话，再在新会话里从总结继续',
    'commands.handoffSummary': '交接到新会话',
    'handoff.busy': '当前有一轮在运行：请等它结束或按 Ctrl-C 后再用 /handoff。',
    'handoff.working': '正在为交接总结会话……',
    'handoff.title': '交接总结',
    'handoff.hint': '开新会话',
    'handoff.sent': '已从 {id} 交接；/resume {id} 可回去',
    'handoff.titlePrefix': '交接：',
    'handoff.intro': '这是从会话 {id} 交接过来的上下文：',
  },
}
