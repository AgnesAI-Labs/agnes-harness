import type { DaemonNotice } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { noticeText, shouldAck } from '../src/runner/notices.js'

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
  })

  it.each(['job_dispatched', 'job_dead'] as const)('suppresses noisy %s notices', (kind) => {
    expect(noticeText({ kind, detail: {}, at: 't' } as DaemonNotice)).toBeNull()
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
