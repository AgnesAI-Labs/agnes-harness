import type { EventEnvelope, UITimeline } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { durableApprovalActions, nodeText, recordRunEvent, webView } from '../src/view.js'

const timeline = (nodes: UITimeline['nodes'], phase: string | null = null): UITimeline => ({
  sessionId: 's',
  upto: 4,
  generation: 1,
  opState: phase === null ? null : { turn: 1, step: 1, phase },
  nodes,
  turns: [],
})

describe('web projection adapter', () => {
  it('distinguishes replayed terminal reasons from a newer active turn and idle state', () => {
    const event = (seq: number, type: string, data: EventEnvelope['data']): EventEnvelope => ({
      seq,
      type,
      data,
      ts: '2026-09-12T00:00:00Z',
      id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
      actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
    })
    const cancelled = recordRunEvent(
      undefined,
      event(7, 'turn/end', { reason: 'aborted', lastAssistantSeq: null }),
    )
    expect(webView(timeline([]), cancelled).status).toBe('已取消')
    const active = recordRunEvent(cancelled, event(8, 'turn/start', { turn: 2, trigger: 'prompt' }))
    const replay = recordRunEvent(
      active,
      event(6, 'turn/end', { reason: 'completed', lastAssistantSeq: null }),
    )
    expect(webView(timeline([], 'inference'), replay).status).toContain('正在执行')
    expect(webView(timeline([]), replay).status).not.toBe('已完成')
    const failure = recordRunEvent(active, event(10, 'turn/end', { reason: 'error', lastAssistantSeq: null }))
    expect(webView(timeline([]), failure).status).toBe('执行失败')
    expect(webView(timeline([])).status).toBe('准备就绪')
  })
  it('renders literal conversation and tool content without HTML interpretation', () => {
    const nodes: UITimeline['nodes'] = [
      { kind: 'user', id: 'u', seq: 1, content: [{ type: 'text', text: '<script>no</script>' }] },
      { kind: 'assistant', id: 'a', seq: 2, text: 'answer', thinking: 'thinking' },
      {
        kind: 'tool',
        id: 't',
        seq: 3,
        toolUseId: 'tc',
        name: 'read',
        status: 'completed',
        summary: 'ok',
        resultPreview: 'file',
      },
    ]
    const view = webView(timeline(nodes, 'inference'))
    expect(view.busy).toBe(true)
    expect(view.nodes.map(nodeText)).toEqual(['<script>no</script>', 'thinking\nanswer', 'ok\n\nfile'])
  })

  it('exposes exactly the pending ticket used by approval.decide', () => {
    const pending: UITimeline['nodes'][number] = {
      kind: 'approval',
      id: 'p',
      seq: 4,
      state: 'pending',
      summary: 'shell?',
      risk: 'destructive',
      options: ['allow_once'],
      ticket: 'opaque-ticket',
    }
    expect(webView(timeline([pending], 'parked')).approval?.ticket).toBe('opaque-ticket')
  })

  it('offers permanent approval only when the projected event explicitly includes it', () => {
    const pending: Extract<UITimeline['nodes'][number], { kind: 'approval' }> = {
      kind: 'approval',
      id: 'p',
      seq: 4,
      state: 'pending',
      summary: 'computer use?',
      risk: 'always',
      options: ['allow_once', 'reject_once'],
      ticket: 'opaque-ticket',
    }
    expect(durableApprovalActions(pending)).toEqual([
      { option: 'allow_once', label: '仅允许这次', verdict: 'allowed-once' },
      { option: 'reject_once', label: '拒绝', verdict: 'rejected' },
    ])
    expect(
      durableApprovalActions({ ...pending, options: ['allow_once', 'allow_permanent', 'reject_once'] }),
    ).toContainEqual({
      option: 'allow_permanent',
      label: '对此配置始终允许',
      verdict: 'allowed-permanent',
    })
  })

  it('removes an expired durable ticket from actions without claiming task success', () => {
    const expired: UITimeline['nodes'][number] = {
      kind: 'approval',
      id: 'p',
      seq: 4,
      state: 'expired',
      summary: 'shell?',
      risk: 'destructive',
      options: ['allow_once'],
      ticket: 'opaque-ticket',
    }
    const view = webView(timeline([expired]), { startSeq: 1, endSeq: 5, reason: 'parked' })
    expect(view.approval).toBeUndefined()
    expect(view.busy).toBe(false)
    expect(view.status).toBe('等待处理')
    expect(view.nodes).toEqual([expired])
  })
})
