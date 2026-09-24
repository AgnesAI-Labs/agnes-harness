// @vitest-environment happy-dom

import type { UINode, UISpan, UITurn } from '@agnes/protocol'
import { traceRowBuilder } from '@agnes/web-units'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TRACE_PANEL_STORAGE_KEY, Trace, type TraceHandle } from '../src/trace-panel.js'

const roots: Array<ReturnType<typeof createRoot>> = []

afterEach(() => {
  while (roots.length) roots.pop()?.unmount()
  document.body.replaceChildren()
  document.body.className = ''
  sessionStorage.clear()
})

const turn = (trace?: UISpan, nodeIds: string[] = []): UITurn => ({
  id: 'turn:1',
  turn: 1,
  startSeq: 1,
  startedAt: '2026-09-17T00:00:00.000Z',
  endedAt: '2026-09-17T00:00:00.080Z',
  durationMs: 80,
  status: 'completed',
  nodeIds,
  usage: {
    totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: true,
    billingComplete: false,
    calls: [],
  },
  inherited: false,
  forkable: true,
  ...(trace ? { trace } : {}),
})

const sampleTrace: UISpan = {
  id: 'turn:1',
  kind: 'turn',
  name: 'Turn 1',
  status: 'completed',
  startSeq: 1,
  startedAt: '2026-09-17T00:00:00.000Z',
  endedAt: '2026-09-17T00:00:00.080Z',
  durationMs: 80,
  children: [
    {
      id: 'span:generation:inf-1',
      kind: 'generation',
      name: 'k3',
      status: 'completed',
      startSeq: 3,
      startedAt: '2026-09-17T00:00:00.010Z',
      durationMs: 40,
      ttftMs: 4,
      model: 'k3',
      nodeIds: ['a1'],
      children: [],
    },
    {
      id: 'span:tool:t1',
      kind: 'tool',
      name: 'bash',
      status: 'completed',
      startSeq: 4,
      startedAt: '2026-09-17T00:00:00.050Z',
      durationMs: 20,
      toolUseId: 'call-1',
      nodeIds: ['t1'],
      children: [],
    },
  ],
}

const nodes: UINode[] = [
  { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: '你好' }] },
  { kind: 'context', id: 'c1', seq: 2, text: 'Current runtime context. workspace-write.' },
  { kind: 'assistant', id: 'a1', seq: 3, text: '我先看一下工作目录。' },
  {
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
  },
]

// The panel only computes while open, so tests that read its content open it first.
function mount(open = true) {
  if (open) sessionStorage.setItem(TRACE_PANEL_STORAGE_KEY, 'open')
  const root = document.createElement('aside')
  const toggle = document.createElement('button')
  const chat = document.createElement('button')
  const conversation = document.createElement('div')
  toggle.id = 'view-trace'
  toggle.textContent = '轨迹'
  chat.id = 'view-chat'
  chat.textContent = '对话'
  document.body.append(root, toggle, chat, conversation)
  const projectUI = vi.fn()
  const reactRoot = createRoot(root)
  const handle = { current: null as TraceHandle | null }
  flushSync(() => {
    reactRoot.render(
      createElement(Trace, {
        ref: handle,
        root,
        options: { toggle, chatToggle: chat, conversation, store: sessionStorage },
      }),
    )
  })
  roots.push(reactRoot)
  if (!handle.current) throw new Error('trace component did not expose its handle')
  return { root, toggle, chat, conversation, panel: handle.current, projectUI }
}

describe('trace panel', () => {
  it('renders event previews, gantt lanes and stats from nodes and turns', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const text = root.textContent ?? ''
    expect(text).toContain('用户')
    expect(text).toContain('你好')
    expect(text).toContain('上下文')
    expect(text).toContain('Current runtime context')
    expect(text).toContain('助手')
    expect(text).toContain('我先看一下工作目录')
    expect(text).toContain('工具')
    expect(text).toContain('bash')
    expect(text).toContain('输入')
    expect(text).toContain('模型')
    expect(text).toContain('时长')
    expect(text).toContain('轮次 1')
    expect(text).toContain('调用 2')
    expect(root.textContent).toContain('第 1 轮')
    const modelBars = [...root.querySelectorAll('.trace-gantt-bar.lane-model')] as HTMLElement[]
    const toolBars = [...root.querySelectorAll('.trace-gantt-bar.lane-tool')] as HTMLElement[]
    expect(modelBars.length).toBeGreaterThan(0)
    expect(toolBars.length).toBeGreaterThan(0)
    expect(modelBars.some((bar) => Number.parseFloat(bar.style.width) > 8)).toBe(true)
  })

  it('shows empty state and does not throw when there are no nodes', () => {
    const { root, panel } = mount()
    expect(() => panel.render([], [turn()])).not.toThrow()
    expect(root.textContent).toContain('发送一条任务后，这里会按步骤显示耗时。')
  })

  it('switches to the trace view and persists without calling projectUI', () => {
    const { root, toggle, chat, conversation, panel, projectUI } = mount(false)
    panel.setOpen(true)
    expect(root.hidden).toBe(false)
    expect(conversation.hidden).toBe(true)
    chat.click()
    expect(root.hidden).toBe(true)
    expect(conversation.hidden).toBe(false)
    expect(sessionStorage.getItem(TRACE_PANEL_STORAGE_KEY)).toBe('closed')
    toggle.click()
    expect(root.hidden).toBe(false)
    expect(projectUI).not.toHaveBeenCalled()
  })

  it('opens inspector tabs from a tool row without calling projectUI', () => {
    const { root, panel, projectUI } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const tool = [...root.querySelectorAll('.trace-row')].find((row) => row.textContent?.includes('bash'))
    ;(tool as HTMLButtonElement | undefined)?.click()
    expect(root.querySelector<HTMLElement>('.trace-inspector')?.hidden).toBe(false)
    expect(root.textContent).toContain('概述')
    expect(root.textContent).toContain('预览')
    expect(root.textContent).toContain('原始内容')
    expect(root.textContent).toContain('来源')
    expect(root.textContent).toContain('工具 · bash')
    const previewTab = [...root.querySelectorAll('.trace-tab')].find((tab) => tab.textContent === '预览')
    ;(previewTab as HTMLButtonElement | undefined)?.click()
    expect(root.querySelector('.trace-inspector-pane:not([hidden])')?.textContent).toContain('ls')
    expect(projectUI).not.toHaveBeenCalled()
  })

  it('puts turn mark, badge and preview in a left-to-right row', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const row = root.querySelector('.trace-row') as HTMLElement
    expect(row.children[0]?.className).toBe('trace-turn-mark')
    expect(row.children[0]?.textContent).toBe('第 1 轮')
    expect(row.children[1]?.classList.contains('trace-badge')).toBe(true)
    expect(row.children[2]?.classList.contains('trace-row-preview')).toBe(true)
  })

  it('filters the event list by search', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const search = root.querySelector('.trace-search') as HTMLInputElement
    search.value = 'bash'
    search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'bash' }))
    const visible = [...root.querySelectorAll('.trace-row')].map((row) => row.textContent)
    expect(visible.some((text) => text?.includes('bash'))).toBe(true)
    expect(visible.some((text) => text?.includes('你好'))).toBe(false)
  })

  it('preserves user and context tones in the input gantt lane', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    expect(root.querySelector('.trace-gantt-bar.tone-user')).not.toBeNull()
    expect(root.querySelector('.trace-gantt-bar.tone-context')).not.toBeNull()
  })

  it('labels an in-flight span as in progress instead of zero milliseconds', () => {
    const { root, panel } = mount()
    const generation = sampleTrace.children.find((child) => child.kind === 'generation')
    if (!generation) throw new Error('sample trace is missing a generation span')
    const { durationMs: _duration, ...runningGeneration } = generation
    const runningTrace: UISpan = {
      ...sampleTrace,
      status: 'running',
      children: [{ ...runningGeneration, status: 'running' }],
    }
    panel.render(nodes.slice(0, 3), [turn(runningTrace, ['u1', 'c1', 'a1'])])
    const row = [...root.querySelectorAll('.trace-row')].find((item) =>
      item.textContent?.includes('我先看一下'),
    )
    ;(row as HTMLButtonElement | undefined)?.click()
    expect(root.querySelector('.trace-inspector')?.textContent).toContain('进行中')
    expect(root.querySelector('.trace-inspector')?.textContent).not.toContain('0 毫秒')
  })

  it('does no work while closed and computes the newest snapshot once when opened', () => {
    const build = vi.spyOn(traceRowBuilder, 'build')
    try {
      const { root, panel } = mount(false)
      build.mockClear()
      for (let i = 0; i < 100; i++) panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
      expect(build).not.toHaveBeenCalled()
      expect(root.querySelector('.trace-row')).toBeNull()
      panel.setOpen(true)
      expect(build).toHaveBeenCalledTimes(1)
      expect(root.textContent).toContain('我先看一下工作目录')
    } finally {
      build.mockRestore()
    }
  })

  it('builds the rows once per render while open', () => {
    const build = vi.spyOn(traceRowBuilder, 'build')
    try {
      const { panel } = mount()
      build.mockClear()
      panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
      expect(build).toHaveBeenCalledTimes(1)
      panel.render(nodes.slice(0, 3), [turn(sampleTrace, ['u1', 'c1', 'a1'])])
      expect(build).toHaveBeenCalledTimes(2)
    } finally {
      build.mockRestore()
    }
  })

  it('keeps each gantt bar element when the time axis compresses differently', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const modelBar = root.querySelector('.trace-gantt-bar.lane-model') as HTMLElement
    const toolBar = root.querySelector('.trace-gantt-bar.lane-tool') as HTMLElement
    const before = `${modelBar.style.width}|${toolBar.style.left}`
    const tool = sampleTrace.children[1] as UISpan
    const later: UISpan = {
      ...sampleTrace,
      children: [sampleTrace.children[0] as UISpan, { ...tool, startedAt: '2026-09-17T00:00:05.000Z' }],
    }
    panel.render(nodes, [turn(later, ['u1', 'c1', 'a1', 't1'])])
    // The compressed axis moved, and still the same elements are reused.
    expect(`${modelBar.style.width}|${toolBar.style.left}`).not.toBe(before)
    expect(root.querySelector('.trace-gantt-bar.lane-model')).toBe(modelBar)
    expect(root.querySelector('.trace-gantt-bar.lane-tool')).toBe(toolBar)
  })

  it('keeps a bar element when another bar appears before it in the same lane', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const toolBar = root.querySelector('.trace-gantt-bar.lane-tool') as HTMLElement
    const earlierTool: UISpan = {
      ...(sampleTrace.children[1] as UISpan),
      id: 'span:tool:t0',
      startedAt: '2026-09-17T00:00:00.020Z',
    }
    const withEarlier: UISpan = { ...sampleTrace, children: [earlierTool, ...sampleTrace.children] }
    panel.render(nodes, [turn(withEarlier, ['u1', 'c1', 'a1', 't1'])])
    const bars = [...root.querySelectorAll('.trace-gantt-bar.lane-tool')]
    expect(bars).toHaveLength(2)
    expect(bars).toContain(toolBar)
  })

  it('renders every bar when two spans share an id', () => {
    const { root, panel } = mount()
    const twin: UISpan = {
      ...sampleTrace,
      children: [...sampleTrace.children, sampleTrace.children[1] as UISpan],
    }
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      panel.render(nodes, [turn(twin, ['u1', 'c1', 'a1', 't1'])])
      expect(root.querySelectorAll('.trace-gantt-bar.lane-tool')).toHaveLength(2)
      // React reports a repeated key; each bar must have its own.
      expect(warn.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('shows a truncated subtree as omitted steps, not as a failure', () => {
    const { root, panel } = mount()
    const truncated: UISpan = {
      ...sampleTrace,
      children: [
        ...sampleTrace.children,
        {
          id: 'span:subagent:c1:truncated',
          kind: 'other',
          name: 'trace-truncated',
          status: 'failed',
          startSeq: 5,
          startedAt: '2026-09-17T00:00:00.070Z',
          error: { code: 'TRACE_TRUNCATED', message: '7' },
          children: [],
        },
      ],
    }
    panel.render(nodes, [turn(truncated, ['u1', 'c1', 'a1', 't1'])])
    expect(root.textContent).toContain('已省略 7 个子步骤')
    expect(root.textContent).not.toContain('失败')
    expect(root.textContent).toContain('调用 2')
    expect(root.querySelector('.trace-gantt-bar.truncated')?.getAttribute('title')).toBe('已省略 7 个子步骤')
  })

  it('marks a partially loaded session and loads earlier records on request', () => {
    const { root, panel } = mount()
    const loadEarlier = vi.fn()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])], { hasEarlier: true, loadEarlier })
    expect(root.textContent).toContain('已加载部分')
    ;(root.querySelector('.trace-load-earlier') as HTMLButtonElement).click()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    expect(root.textContent).not.toContain('已加载部分')
    expect(root.querySelector('.trace-load-earlier')).toBeNull()
  })
})
