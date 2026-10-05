/** @vitest-environment happy-dom */
import type { UINode, UITimeline } from '@agnes/protocol'
import type { TracePanelOptions } from '@agnes/web-units'
import { afterEach, expect, it, vi } from 'vitest'
import { createComparisonTrace } from '../src/comparison-trace.js'

afterEach(() => document.body.replaceChildren())
it('pins comparison tool detail reads to committed nodes and retires replies from a future cut', async () => {
  const root = document.createElement('section')
  const toggle = document.createElement('button')
  const chatToggle = document.createElement('button')
  const conversation = document.createElement('div')
  document.body.append(root, toggle, chatToggle, conversation)
  const tool: Extract<UINode, { kind: 'tool' }> = {
    kind: 'tool',
    id: 't1',
    seq: 4,
    toolUseId: 'call-1',
    name: 'bash',
    status: 'completed',
    summary: '列出文件',
    argsPreview: '{"command":"ls"}',
    resultPreview: 'index.html',
    enforcement: { level: 'full', scope: ['process'] },
    children: [],
  }
  type Detail = Awaited<ReturnType<NonNullable<TracePanelOptions['readToolDetail']>>>
  let finish!: (value: Detail) => void
  const future = new Promise<Parameters<typeof finish>[0]>((resolve) => {
    finish = resolve
  })
  let finishLater!: (value: Detail) => void
  const later = new Promise<Detail>((resolve) => {
    finishLater = resolve
  })
  let resultReads = 0
  const call = { toolUseId: tool.toolUseId, name: 'bash', args: { command: 'captured input' }, ordinal: 0 }
  const readToolDetail = vi.fn(async (_session: string, _call: number, result?: number) =>
    result === 5 ? (++resultReads === 1 ? future : later) : { call },
  )
  const trace = createComparisonTrace(root, {
    sessionId: 'left',
    toggle,
    chatToggle,
    conversation,
    readToolDetail,
  })
  try {
    const full: UITimeline = {
      sessionId: 'left',
      generation: 1,
      upto: 5,
      opState: null,
      turns: [],
      nodes: [{ ...tool, seq: 4, resultSeq: 5 }],
    }
    expect(() => trace.render({ ...full, sessionId: 'right' }, 5)).toThrow('会话或账本位置')
    expect(() => trace.render(full, 4)).toThrow('会话或账本位置')
    trace.render(full, 5)
    toggle.click()
    root.querySelector<HTMLButtonElement>('[data-trace-row-id="t1"]')?.click()
    const input = [...root.querySelectorAll<HTMLButtonElement>('.trace-tab')].find(
      (node) => node.textContent === '完整输入',
    )
    input?.click()
    await vi.waitFor(() => expect(readToolDetail).toHaveBeenCalledWith('left', 4, 5, expect.any(AbortSignal)))
    // Rendering the same immutable coordinates must not rebind or restart detail reads.
    trace.render({ ...full, nodes: [...full.nodes] }, 5)
    await Promise.resolve()
    expect(readToolDetail).toHaveBeenCalledTimes(1)
    const detail: Detail = {
      call,
      result: {
        toolUseId: tool.toolUseId,
        content: [{ type: 'text', text: 'future output must not leak' }],
        isError: false,
        enforcement: { level: 'full', scope: [] },
        authz: { decisionId: 'fixture-decision' },
      },
    }
    finish(detail)
    await vi.waitFor(() => expect(root.textContent).toContain('captured input'))
    // A different cut retaining the same tool needs a new request; no writer generation is invented.
    trace.render({ ...full, upto: 6 }, 6)
    await vi.waitFor(() => expect(readToolDetail).toHaveBeenCalledTimes(2))
    const {
      resultSeq: _resultSeq,
      resultPreview: _resultPreview,
      ...beforeTool
    } = full.nodes[0] as Extract<UINode, { kind: 'tool' }>
    trace.render({ ...full, upto: 4, nodes: [{ ...beforeTool, status: 'running' }] }, 4)
    await vi.waitFor(() =>
      expect(readToolDetail).toHaveBeenCalledWith('left', 4, undefined, expect.any(AbortSignal)),
    )
    finishLater(detail)
    await later
    await Promise.resolve()
    const output = [...root.querySelectorAll<HTMLButtonElement>('.trace-tab')].find(
      (node) => node.textContent === '完整输出',
    )
    output?.click()
    await vi.waitFor(() => expect(root.textContent).toContain('工具结果尚未记录'))
    expect(root.textContent).not.toContain('future output must not leak')
    trace.render({ ...full, upto: 0, nodes: [] }, 0)
    expect(root.querySelector('.trace-inspector[hidden]')).not.toBeNull()
  } finally {
    trace.dispose()
  }
})
