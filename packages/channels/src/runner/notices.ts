import type { DaemonNotice } from '@agnes/protocol'
import type { RunnerConfig } from './config.js'

export function noticeText(notice: DaemonNotice): string | null {
  const detail =
    typeof notice.detail === 'object' && notice.detail !== null && !Array.isArray(notice.detail)
      ? (notice.detail as Record<string, unknown>)
      : {}

  switch (notice.kind) {
    case 'resumed':
      return `上次停在第 ${typeof detail.lastStep === 'number' ? detail.lastStep : '?'} 步，已续跑`
    case 'worker_crashed':
      return '执行中断，30 s 内自动恢复'
    case 'worker_quarantined':
      return '执行反复失败，已暂停；请联系管理员'
    case 'shutting_down':
      return '服务维护中，稍后自动恢复'
    case 'overloaded':
      return '消息太多，正在追赶'
    case 'job_dispatched':
    case 'job_dead':
    // packages_changed / tree_changed 是页面插件名册通知，与渠道机器人无关。
    case 'packages_changed':
    case 'tree_changed':
      return null
  }
}

export function shouldAck(
  mode: RunnerConfig['ackReaction'],
  chatType: 'dm' | 'group' | 'thread',
  mentioned: boolean,
): boolean {
  const group = chatType !== 'dm'
  switch (mode) {
    case 'off':
      return false
    case 'all':
      return true
    case 'direct':
      return !group
    case 'group-all':
      return group
    case 'group-mentions':
      return group && mentioned
  }
}
