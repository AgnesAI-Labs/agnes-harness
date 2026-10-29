import type { UITimeline } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { exitSummaryLines, formatDuration, timelineFacts } from '../src/exit-summary.js'

const node = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, id: kind, seq: 1, ...extra })
const timeline = (nodes: unknown[]) => ({ nodes }) as unknown as UITimeline

describe('exit summary', () => {
  it('counts user messages and pending approvals only, and drops the count when history is unloaded', () => {
    const t = timeline([
      node('user'),
      node('assistant'),
      node('user'),
      node('approval', { state: 'pending' }),
      node('approval', { state: 'decided' }),
    ])
    expect(timelineFacts(t, false)).toEqual({ messages: 2, approvals: 1 })
    expect(timelineFacts(t, true)).toEqual({ approvals: 1 })
  })

  it.each([
    [0, '0s'],
    [59_400, '59s'],
    [65_000, '1m 5s'],
    [3_600_000, '1h 0m 0s'],
    [3_725_000, '1h 2m 5s'],
  ])('formats %d ms as %s', (ms, text) => expect(formatDuration(ms)).toBe(text))

  it('prints one line when nothing waits, and a second one naming what does', () => {
    expect(exitSummaryLines({ elapsedMs: 65_000, messages: 4, approvals: 0, queued: 0 }, 'en')).toEqual([
      'This run lasted 1m 5s · messages: 4',
    ])
    expect(exitSummaryLines({ elapsedMs: 5_000, approvals: 1, queued: 2 }, 'en')).toEqual([
      'This run lasted 5s',
      'Still waiting until you resume: approvals: 1, queued messages: 2',
    ])
    expect(exitSummaryLines({ elapsedMs: 5_000, messages: 1, approvals: 0, queued: 3 }, 'zh-CN')).toEqual([
      '本次运行了 5s · 消息数：1',
      '恢复会话前仍在等待：排队的消息：3',
    ])
  })
})
