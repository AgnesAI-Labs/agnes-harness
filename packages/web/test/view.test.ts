import type { EventEnvelope, UITimeline } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { durableApprovalActions, nodeText, recordRunEvent, webView } from '../src/view.js'
import { enT, zhT } from './helpers/locale.js'

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
    expect(webView(timeline([]), cancelled, zhT).status).toBe('已取消')
    const active = recordRunEvent(cancelled, event(8, 'turn/start', { turn: 2, trigger: 'prompt' }))
    const replay = recordRunEvent(
      active,
      event(6, 'turn/end', { reason: 'completed', lastAssistantSeq: null }),
    )
    for (const [phase, zh, en] of [
      ['inference', '生成回复', 'Generating a reply'],
      ['tools', '执行工具', 'Running tools'],
      ['checkpoint', '检查下一步', 'Checking the next step'],
      ['compaction', '整理上下文', 'Compacting context'],
      ['deferred', '等待外部结果', 'Waiting for external results'],
      ['cancel_requested', '处理停止请求', 'Handling the stop request'],
      ['failure_drain', '处理执行失败', 'Handling the failure'],
    ] as const) {
      expect(webView(timeline([], phase), replay, zhT).status).toBe(zh)
      expect(webView(timeline([], phase), replay, zhT).statusLabel).toBe(`正在执行：${zh}`)
      expect(webView(timeline([], phase), replay, enT).status).toBe(en)
      expect(webView(timeline([], phase), replay, enT).statusLabel).toBe(`Running: ${en}`)
    }
    expect(webView(timeline([]), replay, zhT).status).not.toBe('已完成')
    const failure = recordRunEvent(active, event(10, 'turn/end', { reason: 'error', lastAssistantSeq: null }))
    expect(webView(timeline([]), failure, zhT).status).toBe('执行失败')
    expect(webView(timeline([]), undefined, zhT).status).toBe('准备就绪')
    const current = {
      id: 'turn:1',
      turn: 1,
      startSeq: 8,
      endSeq: 10,
      startedAt: '2026-10-01T00:00:00Z',
      status: 'failed',
      reason: 'blocked',
      verification: 'blocked',
      nodeIds: [],
      inherited: false,
      forkable: false,
      usage: {
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        calls: [],
        reasoningComplete: true,
        billingComplete: true,
      },
    } satisfies UITimeline['turns'][number]
    const receipt = { startSeq: 8, endSeq: 10, reason: 'blocked' as const }
    for (const [verification, reason, status, zh, en] of [
      ['blocked', 'blocked', 'failed', '未通过校验', 'Not verified'],
      ['unverified', 'completed', 'completed', '未通过校验', 'Not verified'],
      ['unavailable', 'completed', 'completed', '未能完成校验', 'Could not complete verification'],
    ] as const) {
      const projection = { ...timeline([]), turns: [{ ...current, verification, reason, status }] }
      const terminal = { ...receipt, reason }
      expect(webView(projection, terminal, zhT)).toMatchObject({ status: zh, statusState: 'not-verified' })
      expect(webView(projection, terminal, enT).status).toBe(en)
      expect(
        webView({ ...projection, opState: { turn: 2, step: 1, phase: 'inference' } }, terminal, zhT),
      ).toMatchObject({ status: '生成回复' })
      expect(webView(projection, { ...terminal, startSeq: 11 }, zhT).statusState).toBeUndefined()
      expect(webView(projection, { ...terminal, endSeq: 12 }, zhT).statusState).toBeUndefined()
      const failed = {
        ...projection,
        turns: [
          {
            ...current,
            verification,
            reason: 'error' as const,
            error: { code: 'E_RUNTIME', message: 'failed' },
          },
        ],
      }
      expect(webView(failed, { ...receipt, reason: 'error' }, zhT)).toMatchObject({ status: '执行失败' })
      expect(webView(failed, { ...receipt, reason: 'error' }, zhT).statusState).toBeUndefined()
    }
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
    const view = webView(timeline(nodes, 'inference'), undefined, zhT)
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
      decisionRef: { sessionId: 's', id: 'opaque-ticket', revision: 1 },
    }
    expect(webView(timeline([pending], 'parked'), undefined, zhT).approval?.decisionRef?.id).toBe(
      'opaque-ticket',
    )
    const parked = timeline([pending], 'tools')
    parked.opState = {
      turn: 1,
      step: 1,
      phase: 'tools',
      parked: {
        decisionRef: { sessionId: 's', id: 'new-ticket', revision: 1 },
        expiresAt: '2099-01-01T00:00:00Z',
      },
    }
    expect(webView(parked, undefined, zhT).approval).toBeUndefined()
    parked.nodes.push({
      ...pending,
      id: 'new-node',
      decisionRef: { sessionId: 's', id: 'new-ticket', revision: 1 },
    })
    expect(webView(parked, undefined, zhT).approval?.decisionRef?.id).toBe('new-ticket')
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
      decisionRef: { sessionId: 's', id: 'opaque-ticket', revision: 1 },
    }
    expect(durableApprovalActions(pending, zhT)).toEqual([
      { option: 'allow_once', label: '仅允许这次', verdict: 'allowed-once' },
      { option: 'reject_once', label: '拒绝', verdict: 'rejected' },
    ])
    expect(
      durableApprovalActions({ ...pending, options: ['allow_once', 'allow_permanent', 'reject_once'] }, zhT),
    ).toContainEqual({
      option: 'allow_permanent',
      label: '对此配置始终允许',
      verdict: 'allowed-permanent',
    })
  })

  it('adds the daemon-offered prefix right after allow-once and skips option kinds it does not know', () => {
    const node = {
      kind: 'approval' as const,
      id: 'p',
      seq: 4,
      state: 'pending' as const,
      summary: 'run it',
      risk: 'always' as const,
      options: ['allow_once', 'allow_from_the_future', 'reject_once'] as never,
      prefixGrant: { tokens: ['git', 'push'], scope: 'shell:prefix:["git","push"]' },
      decisionRef: { sessionId: 's', id: 'ticket', revision: 1 },
    }
    const actions = durableApprovalActions(node, zhT)
    expect(actions.map((action) => action.verdict)).toEqual([
      'allowed-once',
      'allow_prefix_session',
      'rejected',
    ])
    expect(actions[1]?.label).toContain('`git push`')
  })

  it('answers a reconciliation with «执行了 / 没执行» on the same options', () => {
    const asked: Extract<UITimeline['nodes'][number], { kind: 'approval' }> = {
      kind: 'approval',
      id: 'r',
      seq: 5,
      state: 'pending',
      summary: 'did mcp_manage happen? allowed = it happened, rejected = it did not',
      risk: 'unknown',
      options: ['allow_once', 'allow_always', 'reject_once'],
      reconcile: { tool: 'mcp_manage' },
      decisionRef: { sessionId: 's', id: 'reconcile', revision: 1 },
    }
    // One «it ran» even when several allowed options are offered; no session-wide grant wording.
    expect(durableApprovalActions(asked, zhT)).toEqual([
      { option: 'allow_once', label: '执行了', verdict: 'allowed-once' },
      { option: 'reject_once', label: '没执行', verdict: 'rejected' },
    ])
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
      decisionRef: { sessionId: 's', id: 'opaque-ticket', revision: 1 },
    }
    const view = webView(timeline([expired]), { startSeq: 1, endSeq: 5, reason: 'parked' }, zhT)
    expect(view.approval).toBeUndefined()
    expect(view.busy).toBe(false)
    expect(view.status).toBe('等待处理')
    expect(view.nodes).toEqual([expired])
  })
})
