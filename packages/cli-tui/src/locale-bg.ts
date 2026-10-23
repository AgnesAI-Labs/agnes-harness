import type { Locale } from './locale.js'

/** Strings of /bg and its line in the exit summary: kept beside the other locale files so locale-extended.ts stays small. */
export type BgKey =
  | 'commands.bg'
  | 'commands.bgSummary'
  | 'bg.started'
  | 'bg.none'
  | 'bg.picker'
  | 'bg.tooLong'
  | 'bg.tooMany'
  | 'bg.notice'
  | 'bg.state.running'
  | 'bg.state.waiting'
  | 'bg.state.done'
  | 'bg.state.error'
  | 'bg.state.stopped'
  | 'exit.background'

export const BG_DICT: Record<Locale, Record<BgKey, string>> = {
  en: {
    'commands.bg':
      'Run a prompt in a new background session of this workspace and keep working here; with no prompt, list them and switch to one',
    'commands.bgSummary': 'Start a background session',
    'bg.started':
      'Background session {n} started ({id}): {title}. Its end shows in the status bar; /bg lists and opens it',
    'bg.none': 'No background sessions were started in this run; /bg PROMPT starts one',
    'bg.picker': 'Background sessions',
    'bg.tooLong': 'That prompt is longer than {max} characters',
    'bg.tooMany': 'Already {max} background sessions are running; wait for one to finish',
    'bg.notice': 'Background session {n}: {state} · {title}',
    'bg.state.running': 'running',
    'bg.state.waiting': 'waiting for approval',
    'bg.state.done': 'finished',
    'bg.state.error': 'failed',
    'bg.state.stopped': 'stopped',
    'exit.background': 'Background sessions keep running: {items}',
  },
  'zh-CN': {
    'commands.bg':
      '在此工作区新开一个后台会话运行提示，你继续在当前会话工作；不带提示时列出后台会话并可切换过去',
    'commands.bgSummary': '开启后台会话',
    'bg.started': '后台会话 {n} 已开始（{id}）：{title}。结束时状态栏会提示；用 /bg 查看和打开',
    'bg.none': '本次运行还没有开过后台会话；用 /bg 提示 开启一个',
    'bg.picker': '后台会话',
    'bg.tooLong': '这条提示超过 {max} 个字符',
    'bg.tooMany': '已有 {max} 个后台会话在运行，请等其中一个结束',
    'bg.notice': '后台会话 {n}：{state} · {title}',
    'bg.state.running': '运行中',
    'bg.state.waiting': '等待审批',
    'bg.state.done': '已完成',
    'bg.state.error': '出错',
    'bg.state.stopped': '已停止',
    'exit.background': '后台会话仍在运行：{items}',
  },
}
