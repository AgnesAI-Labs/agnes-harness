import type { Locale } from './locale.js'

/** Strings of /fork, /recap and /images: kept beside the other locale files so locale-extended.ts stays small. */
export type SessionViewKey =
  | 'commands.fork'
  | 'commands.forkSummary'
  | 'fork.usage'
  | 'fork.busy'
  | 'fork.noTurns'
  | 'fork.notForkable'
  | 'fork.done'

export const SESSION_VIEW_DICT: Record<Locale, Record<SessionViewKey, string>> = {
  en: {
    'commands.fork': 'Fork a new session from the latest completed turn (or turn N) and switch to it',
    'commands.forkSummary': 'Fork from the latest turn',
    'fork.usage': 'usage: /fork [turn]',
    'fork.busy': 'A turn is running: wait for it to finish (or Ctrl-C) before forking.',
    'fork.noTurns': 'no completed turn to fork at',
    'fork.notForkable': 'Turn {turn} cannot be forked: it is not a completed turn of this session.',
    'fork.done': 'Forked from turn {turn}; the original session is {id} (/resume {id} goes back)',
  },
  'zh-CN': {
    'commands.fork': '从最近一个已完成的回合（或第 N 回合）分叉出新会话并切换过去',
    'commands.forkSummary': '从最新回合分叉',
    'fork.usage': '用法：/fork [回合]',
    'fork.busy': '回合正在进行：等它结束（或按 Ctrl-C）后再分叉。',
    'fork.noTurns': '没有可分叉的已完成回合',
    'fork.notForkable': '第 {turn} 回合不能分叉：它不是本会话已完成的回合。',
    'fork.done': '已从第 {turn} 回合分叉；原会话是 {id}（/resume {id} 可回去）',
  },
}
