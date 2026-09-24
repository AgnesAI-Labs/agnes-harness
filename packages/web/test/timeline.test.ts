// @vitest-environment happy-dom

import { Context } from '@agnes/cordis'
import type { UINode, UITurn } from '@agnes/protocol'
import { SlotRegistry } from '@agnes/web-client'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTimelineRenderer } from '../src/timeline.js'

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'execCommand')
  document.body.replaceChildren()
})

function renderer() {
  const transcript = document.createElement('div')
  const newContentButton = document.createElement('button')
  document.body.append(transcript, newContentButton)
  return {
    transcript,
    timeline: createTimelineRenderer({ transcript, newContentButton }),
  }
}

describe('timeline reader semantics', () => {
  it('projects a keyed DSH chat renderer for one node kind and restores native fallback on removal', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry)
    const registry = (ctx as unknown as { slots: SlotRegistry }).slots
    registry.declare('conversation.chat.node', { kind: 'keyed', scope: 'session' })
    registry.declare('tool.call.toolview', { kind: 'keyed', scope: 'session' })
    registry.setSession('session-a')
    const remove = registry.register(
      { name: 'conversation.chat.node', key: 'assistant', id: 'custom-assistant' },
      () => createElement('div', { id: 'custom-chat-node' }, '扩展 assistant 节点'),
    )
    const removeTool = registry.register({ name: 'tool.call.toolview', key: 'bash', id: 'custom-bash' }, () =>
      createElement('div', { id: 'custom-tool-view' }, '扩展 bash 工具视图'),
    )
    const transcript = document.createElement('div')
    const newContentButton = document.createElement('button')
    document.body.append(transcript, newContentButton)
    const timeline = createTimelineRenderer({ transcript, newContentButton, registry })
    const node: UINode = { kind: 'assistant', id: 'assistant-1', seq: 1, text: '原生回答' }

    timeline.render([node])
    await vi.waitFor(() => {
      expect(transcript.querySelector('#custom-chat-node')?.textContent).toBe('扩展 assistant 节点')
      expect(transcript.querySelector<HTMLElement>('[data-agnes-timeline-native]')?.hidden).toBe(true)
    })

    remove()
    await vi.waitFor(() => {
      expect(transcript.querySelector('#custom-chat-node')).toBeNull()
      expect(transcript.querySelector<HTMLElement>('[data-agnes-timeline-native]')?.hidden).toBe(false)
      expect(transcript.textContent).toContain('原生回答')
    })

    const tool: UINode = {
      kind: 'tool',
      id: 'tool-1',
      seq: 2,
      toolUseId: 'call-1',
      name: 'bash',
      status: 'completed',
      summary: '执行命令',
      enforcement: { level: 'full', scope: ['file'] },
      children: [],
      slots: [],
    }
    timeline.render([node, tool])
    await vi.waitFor(() => {
      expect(transcript.querySelector('#custom-tool-view')?.textContent).toBe('扩展 bash 工具视图')
      expect(
        transcript.querySelector<HTMLElement>('[data-agnes-dsh-slot="tool.call.toolview"]')?.hidden,
      ).toBe(false)
    })

    removeTool()

    const unknownTool: UINode = {
      ...tool,
      id: 'tool-unknown',
      toolUseId: 'call-unknown',
      name: 'unknown_tool',
      summary: '未知工具仍使用原生展示',
    }
    timeline.render([node, unknownTool])
    await vi.waitFor(() => {
      expect(transcript.querySelector('#custom-tool-view')).toBeNull()
      expect(
        transcript.querySelector<HTMLElement>('[data-node-id="tool-unknown"] [data-agnes-timeline-native]')
          ?.hidden,
      ).toBe(false)
      expect(transcript.querySelector('[data-node-id="tool-unknown"]')?.textContent).toContain(
        '未知工具仍使用原生展示',
      )
    })

    const unknownMessage = {
      kind: 'unknown-message',
      id: 'message-unknown',
      seq: 3,
    } as unknown as UINode
    timeline.render([unknownMessage])
    await vi.waitFor(() => {
      expect(
        transcript.querySelector<HTMLElement>('[data-node-id="message-unknown"] [data-agnes-timeline-native]')
          ?.hidden,
      ).toBe(false)
      expect(transcript.querySelector('[data-node-id="message-unknown"]')?.textContent).toContain(
        '暂不支持的内容',
      )
    })

    timeline.reset()
    await ctx.fiber.dispose()
  })

  it('groups a completed turn into one process disclosure, one final answer and one action footer', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const fork = vi.fn(async () => undefined)
    const transcript = document.createElement('div')
    document.body.append(transcript)
    const timeline = createTimelineRenderer({
      transcript,
      newContentButton: document.createElement('button'),
      onFork: fork,
    })
    const nodes: UINode[] = [
      { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: '检查项目' }] },
      { kind: 'assistant', id: 'a1', seq: 2, text: '我先读取文件。' },
      {
        kind: 'tool',
        id: 't1',
        seq: 3,
        toolUseId: 'call-1',
        name: 'read_file',
        status: 'completed',
        summary: '已读取 README.md',
        enforcement: { level: 'full', scope: ['file'] },
        children: [],
        slots: [],
      },
      { kind: 'assistant', id: 'a2', seq: 4, text: '项目状态正常。' },
    ]
    const turn: UITurn = {
      id: 'turn:1',
      turn: 1,
      startSeq: 1,
      endSeq: 5,
      startedAt: '2026-09-13T10:00:00.000Z',
      endedAt: '2026-09-13T10:00:03.000Z',
      durationMs: 3000,
      status: 'completed',
      nodeIds: ['u1', 'a1', 't1', 'a2'],
      finalAssistantId: 'a2',
      usage: {
        totals: { input: 352, output: 140, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        reasoningComplete: true,
        billingComplete: true,
        cost: { usdMicros: 297, source: 'estimated', subscription: false },
        credits: { amount: 0.00020600000000000002, source: 'gateway', complete: true },
        calls: [
          {
            id: 'call-a',
            seq: 2,
            purpose: 'inference',
            model: 'deepseek-chat',
            credits: 0.00020600000000000002,
            creditSource: 'estimated',
          },
          {
            id: 'call-b',
            seq: 4,
            purpose: 'inference',
            model: 'deepseek-chat',
            creditSource: 'estimated',
          },
          {
            id: 'call-guardian',
            seq: 4,
            purpose: 'approval-guardian',
            model: 'deepseek-chat',
            creditSource: 'estimated',
          },
        ],
      },
      inherited: false,
      forkable: true,
    }

    timeline.render(nodes, [turn])

    expect(transcript.querySelectorAll('.conversation-turn')).toHaveLength(1)
    expect(transcript.querySelector('.turn-process summary')?.textContent).toContain('已完成')
    expect(transcript.querySelector('.turn-process summary')?.textContent).not.toContain('项过程')
    expect(transcript.querySelector('.turn-final')?.textContent).toContain('项目状态正常。')
    expect(transcript.querySelector('.turn-meta')?.textContent).toContain('deepseek-chat')
    expect(transcript.querySelector('.turn-meta')?.textContent).not.toContain('用量记录')
    // 用量面板只留关键项（token 与费用），逐条调用明细不再进入面板。
    expect(transcript.querySelector('.turn-usage-grid')?.textContent).toContain('输入 Token352')
    expect(transcript.querySelector('.turn-usage-grid')?.textContent).toContain('输出 Token140')
    expect(transcript.querySelector('.turn-usage-grid')?.textContent).not.toContain('调用记录')
    expect(transcript.querySelector('.turn-usage-grid')?.textContent).toContain('0.000206 credits · 网关记录')
    expect(transcript.querySelector('.turn-usage-grid')?.textContent).not.toContain('0.00020600000000000002')
    vi.stubGlobal('innerWidth', 320)
    vi.stubGlobal('innerHeight', 568)
    // 定位锚点是**触发 pill**（.turn-meta）而不是消息块：此前锚在消息左缘，
    // 点页脚最右的模型名却把面板弹到消息左侧。这里让触发器顶部与页脚不同，
    // 断言值随触发器走，从而锁住这个锚点。
    const trigger = transcript.querySelector<HTMLElement>('.turn-meta')
    if (!trigger) throw new Error('missing usage trigger')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 220,
      y: 400,
      width: 80,
      height: 28,
      top: 400,
      right: 300,
      bottom: 428,
      left: 220,
      toJSON: () => ({}),
    })
    const usageDetails = transcript.querySelector<HTMLDetailsElement>('.turn-usage')
    usageDetails?.setAttribute('open', '')
    usageDetails?.dispatchEvent(new Event('toggle'))
    const usageGrid = transcript.querySelector<HTMLElement>('.turn-usage-grid')
    expect(usageGrid?.style.width).toBe('296px')
    expect(usageGrid?.style.left).toBe('12px')
    // 上方空间 400-12-8 = 380 比下方 568-428-12-8 = 120 大，故向上弹：
    // bottom = 568-400+8 = 176。
    expect(usageGrid?.style.bottom).toBe('176px')
    expect(usageGrid?.style.maxHeight).toBe('380px')
    const process = transcript.querySelector<HTMLDetailsElement>('.turn-process')
    expect(process?.open).toBe(false)
    timeline.render(nodes, [{ ...turn, status: 'running', forkable: false }])
    expect(process?.open).toBe(true)
    // 运行中页脚里的三样东西（复制 / 分支 / 用量）都不可见，空页脚仍有 min-height，
    // 所以必须整行隐藏，否则每个运行中的回合下方都挂着一条 28px 空白带。
    expect(transcript.querySelector<HTMLElement>('.turn-footer')?.hidden).toBe(true)
    timeline.render(nodes, [turn])
    // 运行中的过程在交互结束时自动收起；之后用户仍能手动展开查看。
    expect(process?.open).toBe(false)
    expect(transcript.querySelector<HTMLElement>('.turn-footer')?.hidden).toBe(false)
    // summary 点击仍是唯一手动开关：点开再点回。
    transcript.querySelector<HTMLElement>('.turn-process summary')?.click()
    expect(process?.open).toBe(true)
    timeline.render(nodes, [turn])
    expect(process?.open).toBe(true)
    transcript.querySelector<HTMLElement>('.turn-process summary')?.click()
    expect(process?.open).toBe(false)
    expect(transcript.querySelector<HTMLButtonElement>('[aria-label="复制回答"]')?.title).toBe('复制回答')
    const copy = transcript.querySelector<HTMLButtonElement>('[aria-label="复制回答"]')
    copy?.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('项目状态正常。'))
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error('clipboard denied'))) },
    })
    copy?.focus()
    copy?.click()
    await vi.waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
    expect(transcript.querySelector('.turn-feedback')?.textContent).toBe('已复制')
    expect(document.activeElement).toBe(copy)
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
    execCommand.mockReturnValue(false)
    copy?.click()
    await vi.waitFor(() => expect(transcript.querySelector('.turn-feedback')?.textContent).toBe('复制失败'))
    transcript.querySelector<HTMLButtonElement>('[aria-label="分支到新聊天"]')?.click()
    await vi.waitFor(() => expect(fork).toHaveBeenCalledWith(turn))

    timeline.render(nodes, [{ ...turn, inherited: true }])
    expect(process?.open).toBe(false)
    expect(transcript.querySelector('.conversation-turn')?.getAttribute('data-inherited')).toBe('true')
    expect(transcript.querySelector('.turn-meta')?.textContent).toContain('继承历史')
    // 面板已精简：继承说明不再单列一行，继承状态由页脚摘要承担。
    expect(transcript.querySelector('.turn-usage-grid')?.textContent).not.toContain('费用归属')
  })

  it('keeps final assistant thinking inside the collapsed process while leaving the answer visible', () => {
    const { transcript, timeline } = renderer()
    const nodes: UINode[] = [
      { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: '北京天气' }] },
      {
        kind: 'assistant',
        id: 'a1',
        seq: 2,
        text: '北京今天晴朗。',
        thinking: 'Let me summarize the weather data.',
      },
    ]
    const turn: UITurn = {
      id: 'turn:thinking',
      turn: 1,
      startSeq: 1,
      endSeq: 3,
      startedAt: '2026-09-22T10:00:00.000Z',
      endedAt: '2026-09-22T10:00:01.000Z',
      status: 'completed',
      nodeIds: ['u1', 'a1'],
      finalAssistantId: 'a1',
      usage: {
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        reasoningComplete: true,
        billingComplete: true,
        calls: [],
      },
      inherited: false,
      forkable: false,
    }

    timeline.render(nodes, [turn])

    const process = transcript.querySelector<HTMLDetailsElement>('.turn-process')
    expect(process?.hidden).toBe(false)
    expect(process?.open).toBe(false)
    expect(process?.querySelector('.thinking-content')?.textContent).toContain('summarize the weather data')
    expect(transcript.querySelector('.turn-final .thinking')).toBeNull()
    expect(transcript.querySelector('.turn-final .node-body')?.textContent).toContain('北京今天晴朗。')
    expect(transcript.querySelectorAll('.thinking')).toHaveLength(1)
    timeline.render(nodes, [turn])
    expect(process?.querySelectorAll('.thinking')).toHaveLength(1)
    // If a projection briefly has no turn grouping, the same thinking remains with its assistant.
    timeline.render(nodes)
    const restoredThinking = transcript.querySelector('.assistant .thinking-content')
    expect(restoredThinking).not.toBeNull()
    expect(restoredThinking?.textContent).toContain('summarize the weather data')
    expect(transcript.querySelectorAll('.thinking')).toHaveLength(1)
  })

  it('returns the thinking to its assistant when a later projection stops grouping that node', () => {
    const { transcript, timeline } = renderer()
    const nodes: UINode[] = [
      { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: '北京天气' }] },
      { kind: 'assistant', id: 'a1', seq: 2, text: '北京今天晴朗。', thinking: '先看取回的数据。' },
      { kind: 'user', id: 'u2', seq: 3, content: [{ type: 'text', text: '那明天呢' }] },
      { kind: 'assistant', id: 'a2', seq: 4, text: '明天多云。' },
    ]
    const usage = {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    }
    const first: UITurn = {
      id: 'turn:first',
      turn: 1,
      startSeq: 1,
      endSeq: 3,
      startedAt: '2026-09-22T10:00:00.000Z',
      endedAt: '2026-09-22T10:00:01.000Z',
      status: 'completed',
      nodeIds: ['u1', 'a1'],
      finalAssistantId: 'a1',
      usage,
      inherited: false,
      forkable: false,
    }
    const second: UITurn = {
      ...first,
      id: 'turn:second',
      turn: 2,
      startSeq: 3,
      endSeq: 5,
      nodeIds: ['u2', 'a2'],
      finalAssistantId: 'a2',
    }

    timeline.render(nodes, [first])
    expect(transcript.querySelector('.turn-process .thinking-content')?.textContent).toContain(
      '先看取回的数据。',
    )

    // a1 不再属于任何回合：它的思考块必须跟着它回到游离区，而不是留在旧回合的过程体里。
    timeline.render(nodes, [second])
    const orphan = transcript.querySelector<HTMLElement>('.timeline-unassigned')
    expect(orphan?.hidden).toBe(false)
    expect(orphan?.querySelector('.assistant .thinking-content')?.textContent).toContain('先看取回的数据。')
    expect(orphan?.querySelector('.assistant .node-body')?.textContent).toContain('北京今天晴朗。')
    // 每个 assistant 条目都带一个 details 外壳，这里只数真正有思考内容的那一个。
    expect(transcript.querySelectorAll('.thinking:not([hidden])')).toHaveLength(1)
  })

  it('states tool progress, completion, and a reported failure in text', () => {
    const { transcript, timeline } = renderer()
    const base = {
      kind: 'tool' as const,
      id: 'tool-1',
      seq: 1,
      toolUseId: 'call-1',
      name: 'read_file',
      enforcement: { level: 'full' as const, scope: ['file' as const] },
      children: [],
      slots: [],
    }

    timeline.render([{ ...base, status: 'running', summary: '正在读取 packages/web/src/settings.ts' }])
    const tool = transcript.querySelector<HTMLElement>('.tool')
    expect(tool?.querySelector('.tool-status')?.textContent).toBe('正在执行')
    expect(tool?.getAttribute('aria-label')).toBe('工具 read_file：正在执行')

    timeline.render([{ ...base, status: 'completed', summary: '已读取 packages/web/src/settings.ts' }])
    expect(tool?.querySelector('.tool-status')?.textContent).toBe('执行完成')
    expect(tool?.querySelector('.tool-summary')?.textContent).toBe('已读取 packages/web/src/settings.ts')

    timeline.render([
      {
        ...base,
        status: 'failed',
        summary: '没有权限读取该文件',
        resultPreview: 'Permission denied',
      },
    ])
    expect(tool?.querySelector('.tool-status')?.textContent).toBe('执行失败')
    expect(tool?.querySelector('.tool-summary')?.textContent).toBe('没有权限读取该文件')
    // 「查看详情」是行内展开而不是弹窗：点一下把详情体展开，文案与 aria-expanded 同步。
    const detailButton = tool?.querySelector<HTMLButtonElement>('.tool-detail')
    const toolBody = tool?.querySelector<HTMLElement>('.tool-detail-body')
    expect(detailButton?.getAttribute('aria-expanded')).toBe('false')
    expect(toolBody?.textContent).toContain('错误详情')
    expect(toolBody?.textContent).toContain('Permission denied')
    expect(tool?.dataset.expanded).toBeUndefined()
    detailButton?.click()
    expect(detailButton?.getAttribute('aria-expanded')).toBe('true')
    expect(detailButton?.textContent).toBe('收起详情')
    expect(tool?.dataset.expanded).toBe('true')
    detailButton?.click()
    expect(detailButton?.getAttribute('aria-expanded')).toBe('false')
    expect(tool?.dataset.expanded).toBe('false')
  })

  it('toggles the process block only via its summary, ignoring clicks elsewhere', () => {
    const { transcript, timeline } = renderer()
    const nodes: UINode[] = [
      { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: '跑一个任务' }] },
      {
        kind: 'tool',
        id: 't1',
        seq: 2,
        toolUseId: 'call-1',
        name: 'read_file',
        status: 'running',
        summary: '正在读取文件',
        enforcement: { level: 'full', scope: ['file'] },
        children: [],
        slots: [],
      },
    ]
    const turn: UITurn = {
      id: 'turn:1',
      turn: 1,
      startSeq: 1,
      startedAt: '2026-09-13T10:00:00.000Z',
      status: 'running',
      nodeIds: ['u1', 't1'],
      usage: {
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        reasoningComplete: true,
        billingComplete: true,
        calls: [],
      },
      inherited: false,
      forkable: true,
    }
    timeline.render(nodes, [turn])
    const process = transcript.querySelector<HTMLDetailsElement>('.turn-process')
    expect(process?.open).toBe(true)
    // 过程块不注册「点外部关闭」：点旁边空白对它无效，运行中展开保持展开。
    document.body.click()
    expect(process?.open).toBe(true)
    // summary 点击是唯一的开关：收起后流式渲染保持收起，不再弹回。
    transcript.querySelector<HTMLElement>('.turn-process summary')?.click()
    expect(process?.open).toBe(false)
    timeline.render(nodes, [turn])
    expect(process?.open).toBe(false)
    // 再点 summary 展开，渲染同样尊重这个偏好。
    transcript.querySelector<HTMLElement>('.turn-process summary')?.click()
    expect(process?.open).toBe(true)
    timeline.render(nodes, [turn])
    expect(process?.open).toBe(true)
    // 即使运行中曾手动展开，失败终态仍自动收起一次。
    timeline.render(nodes, [{ ...turn, status: 'failed', endSeq: 3 }])
    expect(process?.open).toBe(false)
    transcript.querySelector<HTMLElement>('.turn-process summary')?.click()
    expect(process?.open).toBe(true)
    timeline.render(nodes, [{ ...turn, status: 'failed', endSeq: 3 }])
    expect(process?.open).toBe(true)
    // 从未碰过过程块的回合，完成时也应自动收起。
    const fresh = renderer()
    fresh.timeline.render(nodes, [turn])
    const freshProcess = fresh.transcript.querySelector<HTMLDetailsElement>('.turn-process')
    expect(freshProcess?.open).toBe(true)
    fresh.timeline.render(nodes, [{ ...turn, status: 'completed', endSeq: 3 }])
    expect(freshProcess?.open).toBe(false)
    // 完成后点 summary 展开，后续渲染尊重这个偏好。
    fresh.transcript.querySelector<HTMLElement>('.turn-process summary')?.click()
    expect(freshProcess?.open).toBe(true)
    fresh.timeline.render(nodes, [{ ...turn, status: 'completed', endSeq: 3 }])
    expect(freshProcess?.open).toBe(true)
    const cancelled = renderer()
    cancelled.timeline.render(nodes, [turn])
    const cancelledProcess = cancelled.transcript.querySelector<HTMLDetailsElement>('.turn-process')
    expect(cancelledProcess?.open).toBe(true)
    cancelled.timeline.render(nodes, [{ ...turn, status: 'cancelled', endSeq: 3 }])
    expect(cancelledProcess?.open).toBe(false)
  })

  it('keeps a selected streamed response connected when settlement moves it into the final answer', () => {
    const { transcript, timeline } = renderer()
    const nodes: UINode[] = [
      { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: '检查流式结果' }] },
      {
        kind: 'assistant',
        id: 'a1',
        seq: 2,
        text: '稳定段落\n\n正在继续输出',
        streaming: true,
      },
    ]
    const running: UITurn = {
      id: 'turn:selection',
      turn: 1,
      startSeq: 1,
      startedAt: '2026-09-22T00:00:00.000Z',
      status: 'running',
      nodeIds: ['u1', 'a1'],
      usage: {
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        reasoningComplete: true,
        billingComplete: true,
        calls: [],
      },
      inherited: false,
      forkable: false,
    }
    timeline.render(nodes, [running])
    const paragraph = transcript.querySelector('.node-body p')
    const range = document.createRange()
    range.selectNodeContents(paragraph?.firstChild ?? transcript)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    timeline.render(
      [
        { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: '检查流式结果' }] },
        {
          kind: 'assistant',
          id: 'a1',
          seq: 2,
          text: '稳定段落\n\n正在继续输出，已经结束',
          streaming: false,
        },
      ],
      [
        {
          ...running,
          status: 'completed',
          endSeq: 2,
          endedAt: '2026-09-22T00:00:01.000Z',
          finalAssistantId: 'a1',
        },
      ],
    )

    expect(document.getSelection()?.toString()).toBe('稳定段落')
    expect(transcript.querySelector('.turn-final .node-body p')).toBe(paragraph)
  })

  it('labels approvals and compaction history without relying on their colors', () => {
    const { transcript, timeline } = renderer()
    timeline.render([
      {
        kind: 'approval',
        id: 'approval-1',
        seq: 1,
        state: 'pending',
        summary: '将在工作目录执行命令',
        risk: 'destructive',
        options: ['allow_once', 'reject_once'],
        ticket: 'ticket-1',
      },
      { kind: 'compaction', id: 'history-1', seq: 2, range: [1, 6] },
    ])

    const approval = transcript.querySelector<HTMLElement>('.approval')
    expect(approval?.textContent).toContain('审批')
    expect(approval?.textContent).toContain('需要你确认')
    expect(approval?.getAttribute('aria-label')).toBe('审批：需要你确认')
    expect(transcript.querySelector('.compaction .node-body')?.textContent).toBe('已整理上下文（范围：1–6）')

    for (const [verdict, expected] of [
      ['rejected', '已拒绝'],
      ['allowed-once', '仅允许这次'],
      ['allowed-session', '本会话允许'],
      ['allowed-permanent', '对此配置始终允许'],
      ['cancelled', '已取消'],
      ['future-verdict', '审批已处理'],
    ] as const) {
      timeline.render([
        {
          kind: 'approval',
          id: 'approval-1',
          seq: 1,
          state: 'decided',
          summary: '将在工作目录执行命令',
          risk: 'destructive',
          options: ['allow_once', 'reject_once'],
          decision: { verdict, via: 'callback' },
        },
        { kind: 'compaction', id: 'history-1', seq: 2, range: [1, 6] },
      ])
      expect(approval?.textContent).toContain(expected)
      expect(approval?.getAttribute('aria-label')).toBe(`审批：${expected}`)
    }
  })

  it('keeps bottom-follow sticky across programmatic writes, user scroll-away and bottom collapse', () => {
    const transcript = document.createElement('div')
    const newContentButton = document.createElement('button')
    document.body.append(transcript, newContentButton)
    // happy-dom 没有布局：几何量全部打桩，滚动事件手工派发。
    const geometry = { scrollTop: 0, scrollHeight: 0, clientHeight: 600 }
    Object.defineProperty(transcript, 'scrollHeight', {
      configurable: true,
      get: () => geometry.scrollHeight,
    })
    Object.defineProperty(transcript, 'clientHeight', {
      configurable: true,
      get: () => geometry.clientHeight,
    })
    Object.defineProperty(transcript, 'scrollTop', {
      configurable: true,
      get: () => geometry.scrollTop,
      set: (value: number) => {
        geometry.scrollTop = value
      },
    })
    Object.defineProperty(transcript, 'scrollTo', {
      configurable: true,
      value: (options: { top: number }) => {
        geometry.scrollTop = options.top
      },
    })
    const timeline = createTimelineRenderer({ transcript, newContentButton })
    const node: UINode = { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: '1' }] }

    // 初始渲染即贴底；程序写入引发的 scroll 事件不解除跟随。
    geometry.scrollHeight = 4000
    timeline.render([node])
    expect(geometry.scrollTop).toBe(4000)
    expect(newContentButton.hidden).toBe(true)
    transcript.dispatchEvent(new Event('scroll'))
    timeline.render([node, { ...node, id: 'u2', seq: 2 }])
    expect(newContentButton.hidden).toBe(true)

    // 内容增长后仍然钉在底部（流式跟随时每帧都在底部）。
    geometry.scrollHeight = 4400
    timeline.render([node, { ...node, id: 'u2', seq: 2 }, { ...node, id: 'u3', seq: 3 }])
    expect(geometry.scrollTop).toBe(4400)

    // 用户主动上滚：跟随解除，新内容只亮"有新内容"，不再拽动视口。
    geometry.scrollTop = 2000
    transcript.dispatchEvent(new Event('scroll'))
    geometry.scrollHeight = 4800
    timeline.render([node, { ...node, id: 'u2', seq: 2 }, { ...node, id: 'u3', seq: 3 }])
    expect(geometry.scrollTop).toBe(2000)
    expect(newContentButton.hidden).toBe(false)

    // 点"有新内容"回到贴底，跟随恢复。
    newContentButton.click()
    expect(geometry.scrollTop).toBe(4800)
    expect(newContentButton.hidden).toBe(true)
    transcript.dispatchEvent(new Event('scroll'))

    // 底部内容塌缩（审批节点挪进过程 details）触发的回钳不算用户滚动：
    // 钳制落点仍贴底，跟随保持，下一次渲染继续钉底。
    geometry.scrollHeight = 1500
    geometry.scrollTop = 900
    transcript.dispatchEvent(new Event('scroll'))
    timeline.render([node])
    expect(geometry.scrollTop).toBe(1500)
    expect(newContentButton.hidden).toBe(true)
  })
})

describe('turn grouping at the edge of a loaded window', () => {
  const tool = (id: string, seq: number): UINode => ({
    kind: 'tool',
    id,
    seq,
    toolUseId: `call-${id}`,
    name: 'read_file',
    status: 'completed',
    summary: `读取 ${id}`,
    enforcement: { level: 'full', scope: ['file'] },
    children: [],
    slots: [],
  })
  const turn = (n: number, nodeIds: string[], finalAssistantId: string): UITurn => ({
    id: `turn:${n}`,
    turn: n,
    startSeq: n * 10,
    endSeq: n * 10 + 9,
    startedAt: '2026-09-24T10:00:00.000Z',
    endedAt: '2026-09-24T10:00:02.000Z',
    durationMs: 2000,
    status: 'completed',
    nodeIds,
    finalAssistantId,
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: false,
      calls: [],
    },
    inherited: false,
    forkable: true,
  })
  const nodes: UINode[] = [
    { kind: 'user', id: 'u1', seq: 10, content: [{ type: 'text', text: '第一问' }] },
    tool('t1', 11),
    { kind: 'assistant', id: 'a1', seq: 12, text: '第一答' },
    { kind: 'user', id: 'u2', seq: 20, content: [{ type: 'text', text: '第二问' }] },
    tool('t2', 21),
    { kind: 'assistant', id: 'a2', seq: 22, text: '第二答' },
  ]
  const turns = [turn(1, ['u1', 't1', 'a1'], 'a1'), turn(2, ['u2', 't2', 'a2'], 'a2')]

  it('keeps a turn whose first nodes are outside the window as one group, then fills it in when they load', () => {
    const { transcript, timeline } = renderer()
    // The window starts inside turn 1: its user message and tool are still unloaded.
    timeline.render(nodes.slice(2), turns)
    const shells = () => [...transcript.querySelectorAll<HTMLElement>('.conversation-turn')]
    expect(shells().map((shell) => shell.dataset.turnId)).toEqual(['turn:1', 'turn:2'])
    const first = shells()[0]
    expect(first?.querySelector('.turn-user')?.childElementCount).toBe(0)
    expect(first?.querySelector('.turn-final')?.textContent).toContain('第一答')
    expect(first?.querySelector('.turn-process-body')?.childElementCount).toBe(0)
    expect(transcript.querySelector<HTMLElement>('.timeline-unassigned')?.hidden).toBe(true)
    expect(shells()[1]?.querySelector('.turn-user')?.textContent).toContain('第二问')

    // Loading earlier prepends the missing nodes into the same turn, not into a new group.
    timeline.render(nodes, turns)
    expect(shells().map((shell) => shell.dataset.turnId)).toEqual(['turn:1', 'turn:2'])
    expect(shells()[0]).toBe(first)
    expect(first?.querySelector('.turn-user')?.textContent).toContain('第一问')
    expect(first?.querySelector('.turn-process-body')?.textContent).toContain('读取 t1')
    expect(transcript.querySelector<HTMLElement>('.timeline-unassigned')?.hidden).toBe(true)
    timeline.reset()
  })
})

describe('loading earlier records', () => {
  function scrolling() {
    const scrollContainer = document.createElement('div')
    const transcript = document.createElement('div')
    const newContentButton = document.createElement('button')
    scrollContainer.append(transcript)
    document.body.append(scrollContainer, newContentButton)
    // happy-dom does no layout: each rendered entry counts as 100px of content.
    Object.defineProperty(scrollContainer, 'scrollHeight', {
      configurable: true,
      get: () => 100 * transcript.querySelectorAll('[data-node-id]').length,
    })
    const timeline = createTimelineRenderer({ transcript, scrollContainer, newContentButton })
    return { scrollContainer, transcript, timeline }
  }
  const say = (id: string, seq: number, text = id): UINode => ({ kind: 'assistant', id, seq, text })

  it('offers older records only while there are some, and asks for them once per render', () => {
    const { scrollContainer, timeline } = scrolling()
    const loadEarlier = vi.fn()
    timeline.render([say('a', 5)], [], { hasEarlier: true, loadEarlier })
    const earlier = scrollContainer.querySelector<HTMLElement>('.transcript-earlier')
    const button = earlier?.querySelector('button')
    expect(earlier?.hidden).toBe(false)
    button?.click()
    button?.click()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    timeline.render([say('a', 5)], [], { hasEarlier: false })
    expect(earlier?.hidden).toBe(true)
  })

  it('keeps the reader in place when earlier nodes are inserted above', () => {
    const { scrollContainer, timeline } = scrolling()
    timeline.render([say('c', 7), say('d', 8), say('e', 9)], [], { hasEarlier: true, loadEarlier: vi.fn() })
    // The reader scrolls up, away from the bottom.
    scrollContainer.scrollTop = 20
    scrollContainer.dispatchEvent(new Event('scroll'))
    timeline.render([say('a', 5), say('b', 6), say('c', 7), say('d', 8), say('e', 9)], [], {
      hasEarlier: false,
    })
    // 300px of content with the reader at 20 became 500px; they stay 280px from the bottom.
    expect(scrollContainer.scrollTop).toBe(220)
  })

  it('stops anchoring once the earlier page is in, so new content below does not move the reader', () => {
    const { scrollContainer, timeline } = scrolling()
    timeline.render([say('c', 7), say('d', 8), say('e', 9)], [], { hasEarlier: true, loadEarlier: vi.fn() })
    scrollContainer.scrollTop = 20
    scrollContainer.dispatchEvent(new Event('scroll'))
    const all = [say('a', 5), say('b', 6), say('c', 7), say('d', 8), say('e', 9)]
    timeline.render(all, [], { hasEarlier: false })
    scrollContainer.scrollTop = 100
    scrollContainer.dispatchEvent(new Event('scroll'))
    timeline.render([...all, say('f', 10)], [], { hasEarlier: false })
    expect(scrollContainer.scrollTop).toBe(100)
  })

  it('does not recompute an entry for a node object it has already rendered', () => {
    const { timeline } = scrolling()
    let reads = 0
    // Only the entry fingerprint reads `streaming`; the visibility filter reads the text.
    const node = {
      kind: 'assistant',
      id: 'a',
      seq: 1,
      text: 'stable text',
      get streaming() {
        reads++
        return false
      },
    } as unknown as UINode
    timeline.render([node])
    const afterFirst = reads
    timeline.render([node])
    timeline.render([node])
    expect(reads).toBe(afterFirst)
  })
})

describe('an attempt whose streamed text was lost', () => {
  it('says how much text was lost instead of showing an empty answer', () => {
    const { transcript, timeline } = renderer()
    const lost: UINode = {
      kind: 'assistant',
      id: 'a1',
      seq: 3,
      text: '',
      streaming: false,
      effectId: 'e1',
      lostChars: 42,
    }
    timeline.render([lost])
    expect(transcript.textContent).toContain('输出中断，至少 42 字未保存')
    const { lostChars: _lost, ...recorded } = lost as Extract<UINode, { kind: 'assistant' }>
    timeline.render([{ ...recorded, text: 'recorded' }])
    expect(transcript.textContent).toContain('recorded')
    expect(transcript.textContent).not.toContain('输出中断')
  })
})
