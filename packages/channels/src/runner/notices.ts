import { AGNES_ERRORS, type DaemonNotice, SESSION_VERSION_CODES } from '@agnes/protocol'
import { JsonRpcError } from '@agnes/sdk'
import type { RunnerConfig } from './config.js'

/** Session-open maps ledger integrity failures to this closed wire code. Ignore all prose. */
export function historyRefusalText(error: unknown): string | null {
  return error instanceof JsonRpcError &&
    error.code === AGNES_ERRORS.SEMANTIC_REJECTED &&
    error.data.code === SESSION_VERSION_CODES.corrupt
    ? '会话历史校验失败，已停止；请联系管理员'
    : null
}

export function noticeText(notice: DaemonNotice): string | null {
  const detail =
    typeof notice.detail === 'object' && notice.detail !== null && !Array.isArray(notice.detail)
      ? (notice.detail as Record<string, unknown>)
      : {}

  switch (notice.kind) {
    case 'automation_attention':
      return '自动化需要人工处理，请查看运行记录和审批收件箱。 / Automation needs attention. Check the run and the approval inbox.'
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
    // Profile invalidations and the session list's run states belong to the Web workbench, not
    // channel conversations.
    case 'session_activity':
    case 'packages_changed':
    case 'tree_changed':
    case 'decisions_changed':
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
