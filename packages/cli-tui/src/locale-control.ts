import type { Locale } from './locale.js'

/**
 * Strings of the tool-detail, child-agent, job and queue surfaces. They live beside locale-extended.ts
 * (which merges them into `tt`) so that file stays under the source-size limit.
 */
export const CONTROL_KEYS = [
  'tool.detail.loading',
  'tool.detail.failed',
  'commands.agents',
  'commands.agentsSummary',
  'agents.none',
  'agents.row',
  'agents.usage',
  'agents.unknown',
  'agents.stopped',
  'agents.resumed',
  'commands.jobs',
  'commands.jobsSummary',
  'jobs.none',
  'jobs.row',
  'jobs.exit',
  'jobs.usage',
  'jobs.unknown',
  'jobs.stopped',
  'jobs.refused',
] as const

export type ControlKey = (typeof CONTROL_KEYS)[number]

export const CONTROL_DICT: Record<Locale, Record<ControlKey, string>> = {
  en: {
    'tool.detail.loading': 'Loading the full record…',
    'tool.detail.failed': 'Full record unavailable ({reason}); showing the preview.',
    'commands.agents':
      'List the subagents this session can control; "stop <n|id>" interrupts one, "resume <n|id> <message>" continues it',
    'commands.agentsSummary': 'Manage subagents',
    'agents.none': 'no controllable subagents',
    'agents.row': '{n}. {id} [{status}] {provider} · {time} · {tokens} tokens · {controls}',
    'agents.usage': 'usage: /agents [stop <n|id> | resume <n|id> <message>]',
    'agents.unknown': 'no subagent {key}',
    'agents.stopped': 'stop requested for {id}',
    'agents.resumed': 'message sent to {id}',
    'commands.jobs': 'List background jobs; "stop <n|id>" kills one',
    'commands.jobsSummary': 'Manage background jobs',
    'jobs.none': 'no background jobs',
    'jobs.row': '{n}. {command} [{status}] · {kind} · {owner}{exit}',
    'jobs.exit': ' · exit {code}',
    'jobs.usage': 'usage: /jobs [stop <n|id>]',
    'jobs.unknown': 'no job {key}',
    'jobs.stopped': 'stop requested for job {id}',
    'jobs.refused': 'stop refused for job {id}',
  },
  'zh-CN': {
    'tool.detail.loading': '正在读取完整记录…',
    'tool.detail.failed': '无法读取完整记录（{reason}），显示的是预览。',
    'commands.agents':
      '列出本会话可控的子智能体；"stop <序号|id>" 中断一个，"resume <序号|id> <消息>" 让它继续',
    'commands.agentsSummary': '管理子智能体',
    'agents.none': '没有可控的子智能体',
    'agents.row': '{n}. {id} [{status}] {provider} · {time} · {tokens} Token · {controls}',
    'agents.usage': '用法：/agents [stop <序号|id> | resume <序号|id> <消息>]',
    'agents.unknown': '没有子智能体 {key}',
    'agents.stopped': '已请求停止 {id}',
    'agents.resumed': '已向 {id} 发送消息',
    'commands.jobs': '列出后台任务；"stop <序号|id>" 终止一个',
    'commands.jobsSummary': '管理后台任务',
    'jobs.none': '没有后台任务',
    'jobs.row': '{n}. {command} [{status}] · {kind} · {owner}{exit}',
    'jobs.exit': ' · 退出码 {code}',
    'jobs.usage': '用法：/jobs [stop <序号|id>]',
    'jobs.unknown': '没有任务 {key}',
    'jobs.stopped': '已请求终止任务 {id}',
    'jobs.refused': '任务 {id} 的终止被拒绝',
  },
}
