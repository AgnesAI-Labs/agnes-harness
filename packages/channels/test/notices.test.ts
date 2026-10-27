import { type DaemonNotice, rpcError, SESSION_VERSION_CODES } from '@agnes/protocol'
import { JsonRpcError } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { historyRefusalText, noticeText, shouldAck } from '../src/runner/notices.js'

describe('historyRefusalText', () => {
  it('uses only the closed session-open refusal, never diagnostic text', () => {
    const detail = {
      code: SESSION_VERSION_CODES.corrupt,
      localized: { 'zh-CN': 'private ledger bytes at /private/history.db' },
      reason: 'private ledger bytes',
    }
    expect(historyRefusalText(new JsonRpcError(rpcError('SEMANTIC_REJECTED', detail)))).toBe(
      '会话历史校验失败，已停止；请联系管理员',
    )
    for (const error of [
      new Error('E_SESSION_CORRUPT: history verification failed'),
      new JsonRpcError(rpcError('INTERNAL_ERROR', detail)),
      new JsonRpcError(rpcError('SEMANTIC_REJECTED', { code: SESSION_VERSION_CODES.older })),
      new JsonRpcError(rpcError('SEMANTIC_REJECTED', { code: SESSION_VERSION_CODES.newer })),
      new JsonRpcError(rpcError('SEMANTIC_REJECTED', { reason: 'E_SESSION_CORRUPT' })),
    ]) {
      expect(historyRefusalText(error)).toBeNull()
    }
  })
})

describe('noticeText', () => {
  it('maps actionable daemon notices to stable Chinese copy', () => {
    expect(noticeText({ kind: 'resumed', sessionId: 'k', detail: { lastStep: 4 }, at: 't' })).toBe(
      '上次停在第 4 步，已续跑',
    )
    expect(noticeText({ kind: 'resumed', detail: {}, at: 't' })).toBe('上次停在第 ? 步，已续跑')
    expect(noticeText({ kind: 'worker_crashed', detail: {}, at: 't' })).toBe('执行中断，30 s 内自动恢复')
    expect(noticeText({ kind: 'worker_quarantined', detail: {}, at: 't' })).toBe(
      '执行反复失败，已暂停；请联系管理员',
    )
    expect(noticeText({ kind: 'shutting_down', detail: {}, at: 't' })).toBe('服务维护中，稍后自动恢复')
    expect(noticeText({ kind: 'overloaded', detail: {}, at: 't' })).toBe('消息太多，正在追赶')
    const attention = noticeText({ kind: 'automation_attention', sessionId: 'run', detail: {}, at: 't' })
    expect(attention).toContain('需要人工处理')
    expect(attention).toContain('Automation needs attention')
  })

  it.each([
    { kind: 'job_dispatched', detail: {}, at: 't' },
    { kind: 'job_dead', detail: {}, at: 't' },
    {
      kind: 'session_activity',
      sessionId: 'k',
      detail: {
        profile: 'default',
        owner: 'operator',
        sessionId: 'k',
        state: 'waiting',
        waiting: 'approval',
      },
      at: 't',
    },
    {
      kind: 'decisions_changed',
      detail: { profile: 'default', principal: { id: 'operator', org: 'local' } },
      at: 't',
    },
  ] satisfies DaemonNotice[])('suppresses noisy $kind notices', (notice) => {
    expect(noticeText(notice)).toBeNull()
  })
})

describe('shouldAck', () => {
  it.each([
    ['off', 'dm', true, false],
    ['all', 'group', false, true],
    ['direct', 'dm', false, true],
    ['direct', 'group', true, false],
    ['group-all', 'group', false, true],
    ['group-all', 'dm', false, false],
    ['group-mentions', 'group', true, true],
    ['group-mentions', 'group', false, false],
    ['group-mentions', 'thread', true, true],
  ] as const)('%s on %s mentioned=%s -> %s', (mode, chatType, mentioned, want) => {
    expect(shouldAck(mode, chatType, mentioned)).toBe(want)
  })
})
