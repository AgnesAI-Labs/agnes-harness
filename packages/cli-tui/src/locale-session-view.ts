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
  | 'commands.recap'
  | 'commands.recapSummary'
  | 'recap.session'
  | 'recap.turns'
  | 'recap.request'
  | 'recap.plan'
  | 'recap.files'
  | 'recap.background'
  | 'recap.schedules'
  | 'recap.context'

export const SESSION_VIEW_DICT: Record<Locale, Record<SessionViewKey, string>> = {
  en: {
    'commands.fork': 'Fork a new session from the latest completed turn (or turn N) and switch to it',
    'commands.forkSummary': 'Fork from the latest turn',
    'fork.usage': 'usage: /fork [turn]',
    'fork.busy': 'A turn is running: wait for it to finish (or Ctrl-C) before forking.',
    'fork.noTurns': 'no completed turn to fork at',
    'fork.notForkable': 'Turn {turn} cannot be forked: it is not a completed turn of this session.',
    'fork.done': 'Forked from turn {turn}; the original session is {id} (/resume {id} goes back)',
    'commands.recap': 'Summarise where this session stands from local data (no model call)',
    'commands.recapSummary': 'Where the session stands',
    'recap.session': 'Session',
    'recap.turns': 'Turns',
    'recap.request': 'Last request',
    'recap.plan': 'Plan',
    'recap.files': 'Files changed',
    'recap.background': 'Background',
    'recap.schedules': 'Scheduled',
    'recap.context': 'Context',
  },
  'zh-CN': {
    'commands.fork': '从最近一个已完成的回合（或第 N 回合）分叉出新会话并切换过去',
    'commands.forkSummary': '从最新回合分叉',
    'fork.usage': '用法：/fork [回合]',
    'fork.busy': '回合正在进行：等它结束（或按 Ctrl-C）后再分叉。',
    'fork.noTurns': '没有可分叉的已完成回合',
    'fork.notForkable': '第 {turn} 回合不能分叉：它不是本会话已完成的回合。',
    'fork.done': '已从第 {turn} 回合分叉；原会话是 {id}（/resume {id} 可回去）',
    'commands.recap': '用本地已有的数据汇总会话进展（不调用模型）',
    'commands.recapSummary': '会话进展回顾',
    'recap.session': '会话',
    'recap.turns': '回合数',
    'recap.request': '最后请求',
    'recap.plan': '计划',
    'recap.files': '改动文件',
    'recap.background': '后台会话',
    'recap.schedules': '定时任务',
    'recap.context': '上下文',
  },
}
