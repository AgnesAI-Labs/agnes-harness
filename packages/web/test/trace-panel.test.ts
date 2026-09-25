// @vitest-environment happy-dom

import type { UINode, UISpan, UITurn } from '@agnes/protocol'
import { traceRowBuilder } from '@agnes/web-units'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TRACE_PANEL_STORAGE_KEY,
  Trace,
  type TraceHandle,
  type TracePanelOptions,
} from '../src/trace-panel.js'

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
function mount(open = true, readToolDetail?: TracePanelOptions['readToolDetail']) {
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
        options: {
          toggle,
          chatToggle: chat,
          conversation,
          store: sessionStorage,
          ...(readToolDetail ? { readToolDetail } : {}),
        },
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
    expect(root.textContent).toContain('投影内容')
    expect(root.textContent).toContain('来源')
    expect(root.textContent).toContain('工具 · bash')
    const previewTab = [...root.querySelectorAll('.trace-tab')].find((tab) => tab.textContent === '预览')
    ;(previewTab as HTMLButtonElement | undefined)?.click()
    expect(root.querySelector('.trace-inspector-pane:not([hidden])')?.textContent).toContain('ls')
    const projectionTab = [...root.querySelectorAll('.trace-tab')].find(
      (tab) => tab.textContent === '投影内容',
    )
    ;(projectionTab as HTMLButtonElement | undefined)?.click()
    expect(root.querySelector('.trace-inspector-pane:not([hidden])')?.textContent).toContain('可能已截断')
    expect(projectUI).not.toHaveBeenCalled()
  })

  it('loads full tool input and output on selection without rendering image bytes as text', async () => {
    const readToolDetail = vi.fn().mockResolvedValue({
      call: { toolUseId: 'call-1', name: 'bash', args: { command: 'echo complete input' }, ordinal: 0 },
      result: {
        toolUseId: 'call-1',
        content: [
          { type: 'text', text: 'complete output beyond the preview' },
          { type: 'image', data: 'IMAGE_BYTES', mimeType: 'image/png' },
        ],
        isError: false,
        enforcement: { level: 'full', scope: [] },
        authz: { decisionId: 'decision-1' },
      },
    })
    const { root, panel } = mount(true, readToolDetail)
    const withResultSeq = nodes.map((node) => (node.kind === 'tool' ? { ...node, resultSeq: 5 } : node))
    panel.render(withResultSeq, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])], {
      hasEarlier: false,
      sessionId: 'session-one',
    })
    root.querySelector<HTMLButtonElement>('[data-trace-row-id="t1"]')?.click()
    expect(readToolDetail).not.toHaveBeenCalled()
    const input = [...root.querySelectorAll<HTMLButtonElement>('.trace-tab')].find(
      (tab) => tab.textContent === '完整输入',
    )
    input?.click()
    await vi.waitFor(() =>
      expect(readToolDetail).toHaveBeenCalledWith('session-one', 4, 5, expect.any(AbortSignal)),
    )
    await vi.waitFor(() =>
      expect(root.querySelector('.trace-inspector-pane:not([hidden])')?.textContent).toContain(
        'echo complete input',
      ),
    )
    const output = [...root.querySelectorAll<HTMLButtonElement>('.trace-tab')].find(
      (tab) => tab.textContent === '完整输出',
    )
    output?.click()
    expect(root.querySelector('.trace-inspector-pane:not([hidden])')?.textContent).toContain(
      'complete output beyond the preview',
    )
    expect(root.querySelector('.trace-inspector-pane:not([hidden]) img')?.getAttribute('src')).toBe(
      'data:image/png;base64,IMAGE_BYTES',
    )
    expect(root.querySelector('.trace-inspector-pane:not([hidden])')?.textContent).not.toContain(
      'IMAGE_BYTES',
    )
  })

  it('shows unknown duration for a completed tool without a recorded span', () => {
    const { root, panel } = mount(true, vi.fn())
    panel.render(nodes, [turn(undefined, ['u1', 'c1', 'a1', 't1'])], {
      hasEarlier: false,
      sessionId: 'session-one',
    })
    root.querySelector<HTMLButtonElement>('[data-trace-row-id="t1"]')?.click()
    root.querySelector<HTMLButtonElement>('[data-pane="timing"]')?.click()
    const timing = root.querySelector('.trace-inspector-pane:not([hidden])')?.textContent
    expect(timing).toContain('时长未知')
    expect(timing).not.toContain('进行中')
  })

  it('discards a late tool-detail result after changing sessions', async () => {
    let resolveOld: ((value: unknown) => void) | undefined
    const old = new Promise((resolve) => {
      resolveOld = resolve
    })
    const readToolDetail = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValue({
        call: { toolUseId: 'call-1', name: 'bash', args: { command: 'new session' }, ordinal: 0 },
      })
    const { root, panel } = mount(true, readToolDetail)
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])], {
      hasEarlier: false,
      sessionId: 'old',
    })
    root.querySelector<HTMLButtonElement>('[data-trace-row-id="t1"]')?.click()
    ;[...root.querySelectorAll<HTMLButtonElement>('.trace-tab')]
      .find((tab) => tab.textContent === '完整输入')
      ?.click()
    await vi.waitFor(() => expect(readToolDetail).toHaveBeenCalledTimes(1))
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])], {
      hasEarlier: false,
      sessionId: 'new',
    })
    expect(root.querySelector('.trace-inspector')?.hasAttribute('hidden')).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-trace-row-id="t1"]')?.click()
    ;[...root.querySelectorAll<HTMLButtonElement>('.trace-tab')]
      .find((tab) => tab.textContent === '完整输入')
      ?.click()
    await vi.waitFor(() => expect(readToolDetail).toHaveBeenCalledTimes(2))
    resolveOld?.({
      call: { toolUseId: 'call-1', name: 'bash', args: { command: 'old session' }, ordinal: 0 },
    })
    const input = [...root.querySelectorAll<HTMLButtonElement>('.trace-tab')].find(
      (tab) => tab.textContent === '完整输入',
    )
    input?.click()
    await vi.waitFor(() =>
      expect(root.querySelector('.trace-inspector-pane:not([hidden])')?.textContent).toContain('new session'),
    )
    expect(root.querySelector('.trace-inspector-pane:not([hidden])')?.textContent).not.toContain(
      'old session',
    )
  })

  it('groups records by turn with step, badge and preview columns', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const row = root.querySelector('.trace-row') as HTMLElement
    expect(root.querySelector('.trace-turn-toggle')?.textContent).toContain('第 1 轮 · 4 条记录')
    expect(row.children[0]?.classList.contains('trace-step-mark')).toBe(true)
    expect(row.children[1]?.classList.contains('trace-badge')).toBe(true)
    expect(row.children[2]?.classList.contains('trace-row-preview')).toBe(true)
  })

  it('folds a turn, reveals search matches, and expands it for timeline selection', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const fold = root.querySelector<HTMLButtonElement>('.trace-turn-toggle') as HTMLButtonElement
    fold.click()
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(root.querySelectorAll('.trace-row')).toHaveLength(0)
    const search = root.querySelector('.trace-search') as HTMLInputElement
    search.value = 'bash'
    search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'bash' }))
    expect(root.querySelectorAll('.trace-row')).toHaveLength(1)
    search.value = ''
    search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
    expect(root.querySelectorAll('.trace-row')).toHaveLength(0)
    root.querySelector<HTMLButtonElement>('.trace-gantt-bar.lane-model')?.click()
    expect(root.querySelector('.trace-turn-toggle')?.getAttribute('aria-expanded')).toBe('true')
    expect(root.querySelector('.trace-row[aria-current="true"]')?.getAttribute('data-trace-row-id')).toBe(
      'a1',
    )
  })

  it('folds and expands every loaded turn from the toolbar', () => {
    const { root, panel } = mount()
    const second: UITurn = {
      ...turn(undefined, ['u2']),
      id: 'turn:2',
      turn: 2,
      startSeq: 5,
    }
    const secondUser: UINode = { kind: 'user', id: 'u2', seq: 5, content: [{ type: 'text', text: '继续' }] }
    panel.render([...nodes, secondUser], [turn(sampleTrace, ['u1', 'c1', 'a1', 't1']), second])
    const foldAll = root.querySelector<HTMLButtonElement>('.trace-fold-all') as HTMLButtonElement
    expect(root.querySelectorAll('.trace-turn-toggle')).toHaveLength(2)
    foldAll.click()
    expect(root.querySelectorAll('.trace-row')).toHaveLength(0)
    expect(foldAll.getAttribute('aria-label')).toBe('展开所有轮次')
    foldAll.click()
    expect(root.querySelectorAll('.trace-row')).toHaveLength(5)
  })

  it('folds nested tool calls without hiding unrelated intervening records', () => {
    const { root, panel } = mount()
    const parent: UINode = {
      ...(nodes[3] as Extract<UINode, { kind: 'tool' }>),
      id: 'parent-tool',
      seq: 2,
      toolUseId: 'parent',
      name: 'parent_tool',
      children: ['child-tool'],
    }
    const child: UINode = {
      ...(nodes[3] as Extract<UINode, { kind: 'tool' }>),
      id: 'child-tool',
      seq: 4,
      toolUseId: 'child',
      name: 'child_tool',
      depth: 1,
      children: [],
    }
    const unrelated: UINode = { kind: 'context', id: 'unrelated', seq: 3, text: 'unrelated context' }
    panel.render([nodes[0] as UINode, parent, unrelated, child])
    const toggle = root.querySelector<HTMLButtonElement>('.trace-tool-toggle') as HTMLButtonElement
    toggle.click()
    expect(root.querySelector('[data-trace-row-id="child-tool"]')).toBeNull()
    expect(root.querySelector('[data-trace-row-id="unrelated"]')).not.toBeNull()
    const search = root.querySelector<HTMLInputElement>('.trace-search') as HTMLInputElement
    search.value = 'child_tool'
    search.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'child_tool' }),
    )
    expect(root.querySelector('[data-trace-row-id="child-tool"]')).not.toBeNull()
    search.value = ''
    search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
    expect(root.querySelector('[data-trace-row-id="child-tool"]')).toBeNull()
    const mode = root.querySelector<HTMLSelectElement>('#trace-timeline-mode') as HTMLSelectElement
    mode.value = 'sequence'
    flushSync(() => mode.dispatchEvent(new Event('change', { bubbles: true })))
    root.querySelector<HTMLButtonElement>('[data-target-id="child-tool"]')?.click()
    expect(root.querySelector('[data-trace-row-id="child-tool"]')).not.toBeNull()
    expect(root.querySelector('.trace-tool-toggle')?.getAttribute('aria-expanded')).toBe('true')
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

  it('shows attachment-only input from safe metadata and keeps image data out of the ledger', () => {
    const { root, panel } = mount()
    const attachmentOnly: UINode = {
      kind: 'user',
      id: 'u-attachment',
      seq: 1,
      content: [
        { type: 'image', data: 'PRIVATE_IMAGE_BYTES', mimeType: 'image/png' },
        { type: 'resource_link', uri: 'resource://private', name: 'notes.txt', mimeType: 'text/plain' },
      ],
    }
    panel.render([attachmentOnly], [turn(undefined, ['u-attachment'])])
    expect(root.querySelector('.trace-row')?.textContent).toContain('1 张图片 · 1 个资源链接')
    ;(root.querySelector('.trace-row') as HTMLButtonElement).click()
    expect(root.querySelector('.trace-inspector')?.textContent).toContain('图片 · image/png')
    expect(root.querySelector('.trace-inspector')?.textContent).toContain('notes.txt')
    const thumb = root.querySelector<HTMLButtonElement>('.trace-image-thumb')
    thumb?.focus()
    flushSync(() => thumb?.click())
    expect(root.querySelector('.trace-lightbox img')?.getAttribute('src')).toBe(
      'data:image/png;base64,PRIVATE_IMAGE_BYTES',
    )
    const close = root.querySelector<HTMLButtonElement>('.trace-lightbox-close')
    expect(document.activeElement).toBe(close)
    flushSync(() => close?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
    expect(root.querySelector('.trace-lightbox')).toBeNull()
    expect(document.activeElement).toBe(thumb)
    expect(root.textContent).not.toContain('PRIVATE_IMAGE_BYTES')
    expect(root.textContent).not.toContain('resource://private')
  })

  it('includes the recorded tool summary in the ledger', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const tool = [...root.querySelectorAll('.trace-row')].find((row) => row.textContent?.includes('bash'))
    expect(tool?.textContent).toContain('列出文件')
  })

  it('preserves user and context tones in the input gantt lane', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    expect(root.querySelector('.trace-gantt-bar.tone-user')).not.toBeNull()
    expect(root.querySelector('.trace-gantt-bar.tone-context')).not.toBeNull()
    expect((root.querySelector('.trace-gantt-bar.tone-user') as HTMLElement).style.width).toBe('0%')
    expect(root.querySelector('.trace-gantt-bar.tone-user')?.getAttribute('title')).toContain(
      '按轮次起点定位',
    )
  })

  it('shows step, error and turn usage from recorded trace data', () => {
    const { root, panel } = mount()
    const generation = sampleTrace.children[0] as UISpan
    const step: UISpan = {
      id: 'span:step:1:1',
      kind: 'step',
      name: 'Step 1',
      status: 'failed',
      startSeq: 2,
      startedAt: sampleTrace.startedAt,
      children: [{ ...generation, status: 'failed', callSeq: 5, error: { code: 'MODEL_TIMEOUT' } }],
    }
    const activeTurn: UITurn = {
      ...turn({ ...sampleTrace, children: [step] }, ['u1', 'a1']),
      usage: {
        ...turn().usage,
        totals: { input: 12, output: 5, cacheRead: 2, cacheWrite: 0, reasoning: 1 },
        calls: [
          {
            id: 'e1',
            seq: 5,
            purpose: 'inference',
            model: 'k3',
            creditSource: 'estimated',
            tokens: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0 },
          },
        ],
      },
    }
    panel.render([nodes[0] as UINode, nodes[2] as UINode], [activeTurn])
    const assistant = [...root.querySelectorAll<HTMLButtonElement>('.trace-row')].find((row) =>
      row.textContent?.includes('我先看一下'),
    )
    expect(assistant?.textContent).toContain('Step 1')
    expect(assistant?.textContent).toContain('失败')
    expect(assistant?.textContent).toContain('MODEL_TIMEOUT')
    assistant?.click()
    const inspector = root.querySelector('.trace-inspector')
    expect(inspector?.textContent).toContain('步骤Step 1')
    expect(inspector?.textContent).toContain('错误码MODEL_TIMEOUT')
    expect(inspector?.textContent).toContain('本轮用量输入 12 · 输出 5')
    expect(inspector?.textContent).toContain('当前调用输入 7 · 输出 3')
    expect(inspector?.textContent).toContain('请求顺序1')
    expect(inspector?.textContent).toContain('入账顺序1')
    expect(inspector?.textContent).toContain('累计入账用量输入 7 · 输出 3')
    panel.render(
      [nodes[0] as UINode, nodes[2] as UINode],
      [
        {
          ...activeTurn,
          usage: { ...activeTurn.usage, reasoningComplete: false },
        },
      ],
    )
    expect(root.querySelector('.trace-inspector')?.textContent).toContain('推理 未提供')
    panel.render(
      [nodes[0] as UINode, nodes[2] as UINode],
      [
        {
          ...activeTurn,
          trace: {
            ...(activeTurn.trace as UISpan),
            children: [{ ...step, children: [{ ...generation, callSeq: 9 }] }],
          },
        },
      ],
    )
    expect(root.querySelector('.trace-inspector')?.textContent).not.toContain('当前调用')
  })

  it('selects the linked record from the time overview, including a filtered record', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const search = root.querySelector('.trace-search') as HTMLInputElement
    search.value = 'bash'
    search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'bash' }))
    const model = root.querySelector<HTMLButtonElement>('.trace-gantt-bar.lane-model')
    expect(model?.dataset.targetId).toBe('a1')
    model?.click()
    expect(search.value).toBe('')
    expect(root.querySelector('.trace-row[aria-current="true"]')?.getAttribute('data-trace-row-id')).toBe(
      'a1',
    )
    expect(model?.getAttribute('aria-pressed')).toBe('true')
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
    const modelBar = root.querySelector<HTMLElement>('.trace-gantt-bar.lane-model')
    expect(modelBar?.style.width).toBe('0%')
    expect(modelBar?.getAttribute('title')).toContain('进行中')
    const row = [...root.querySelectorAll('.trace-row')].find((item) =>
      item.textContent?.includes('我先看一下'),
    )
    ;(row as HTMLButtonElement | undefined)?.click()
    expect(root.querySelector('.trace-inspector')?.textContent).toContain('进行中')
    expect(root.querySelector('.trace-inspector')?.textContent).not.toContain('0 毫秒')
  })

  it('keeps overlapping spans at their recorded relative positions', () => {
    const { root, panel } = mount()
    const tool = sampleTrace.children[1] as UISpan
    const overlapping: UISpan = {
      ...sampleTrace,
      children: [sampleTrace.children[0] as UISpan, { ...tool, startedAt: '2026-09-17T00:00:00.020Z' }],
    }
    panel.render(nodes, [turn(overlapping, ['u1', 'c1', 'a1', 't1'])])
    const modelBar = root.querySelector<HTMLElement>('.trace-gantt-bar.lane-model') as HTMLElement
    const toolBar = root.querySelector<HTMLElement>('.trace-gantt-bar.lane-tool') as HTMLElement
    const modelEnd = Number.parseFloat(modelBar.style.left) + Number.parseFloat(modelBar.style.width)
    expect(Number.parseFloat(toolBar.style.left)).toBeLessThan(modelEnd)
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

  it('filters the ledger by a dragged timeline interval and resets it with Escape', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const mode = root.querySelector<HTMLSelectElement>('#trace-timeline-mode') as HTMLSelectElement
    mode.value = 'sequence'
    flushSync(() => mode.dispatchEvent(new Event('change', { bubbles: true })))
    expect((root.querySelector('.trace-gantt-bar.tone-user') as HTMLElement).style.width).toBe('25%')
    const track = root.querySelectorAll<HTMLElement>('.trace-gantt-track')[1] as HTMLElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 10,
      width: 100,
      height: 10,
      toJSON: () => ({}),
    })
    flushSync(() => {
      track.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 0 }),
      )
      track.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 1, clientX: 20 }),
      )
      track.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: 20 }),
      )
    })
    expect(root.querySelectorAll('.trace-row')).toHaveLength(1)
    expect(root.querySelector('.trace-row')?.getAttribute('data-trace-row-id')).toBe('u1')
    expect(root.querySelector('.trace-gantt-clear')).not.toBeNull()
    const firstTrack = root.querySelector<HTMLElement>('.trace-gantt-track') as HTMLElement
    flushSync(() => firstTrack.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
    expect(root.querySelectorAll('.trace-row')).toHaveLength(4)
    expect(root.querySelector('.trace-gantt-clear')).toBeNull()
    vi.spyOn(firstTrack, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 10,
      width: 100,
      height: 10,
      toJSON: () => ({}),
    })
    const before = Number.parseFloat((root.querySelector('[data-target-id="a1"]') as HTMLElement).style.width)
    flushSync(() =>
      root
        .querySelector('.trace-gantt')
        ?.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 50, deltaY: -1000 }),
        ),
    )
    expect(
      Number.parseFloat((root.querySelector('[data-target-id="a1"]') as HTMLElement).style.width),
    ).toBeGreaterThan(before)
  })

  it('keeps untimed records when the selected interval covers the full timeline', () => {
    const { root, panel } = mount()
    const approval: UINode = {
      kind: 'approval',
      id: 'ap1',
      seq: 5,
      state: 'pending',
      ticket: 'ticket-1',
      summary: 'Allow action?',
      risk: 'unknown',
      options: [],
    }
    panel.render([...nodes, approval], [turn(sampleTrace, ['u1', 'c1', 'a1', 't1', 'ap1'])])
    const track = root.querySelectorAll<HTMLElement>('.trace-gantt-track')[1] as HTMLElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 10,
      width: 100,
      height: 10,
      toJSON: () => ({}),
    })
    flushSync(() => {
      track.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 0 }),
      )
      track.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: 100 }),
      )
    })
    expect(root.querySelectorAll('.trace-row')).toHaveLength(5)
    expect(root.querySelector('[data-trace-row-id="ap1"]')).not.toBeNull()
  })

  it('keeps a selected record range stable while new records append', () => {
    const { root, panel } = mount()
    const current: UINode[] = Array.from({ length: 4 }, (_, index) => ({
      kind: 'user',
      id: `stable${index}`,
      seq: index + 1,
      content: [{ type: 'text', text: `stable ${index}` }],
    }))
    panel.render(current)
    const mode = root.querySelector<HTMLSelectElement>('#trace-timeline-mode') as HTMLSelectElement
    mode.value = 'sequence'
    flushSync(() => mode.dispatchEvent(new Event('change', { bubbles: true })))
    const track = root.querySelectorAll<HTMLElement>('.trace-gantt-track')[1] as HTMLElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 10,
      width: 100,
      height: 10,
      toJSON: () => ({}),
    })
    flushSync(() => {
      track.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 0 }),
      )
      track.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: 20 }),
      )
    })
    expect(root.querySelectorAll('.trace-row')).toHaveLength(1)
    panel.render([
      ...current,
      {
        kind: 'user',
        id: 'appended',
        seq: 5,
        content: [{ type: 'text', text: 'appended' }],
      },
    ])
    expect(root.querySelectorAll('.trace-row')).toHaveLength(1)
    expect(root.querySelector('.trace-row')?.getAttribute('data-trace-row-id')).toBe('stable0')
  })

  it('zooms the sequence timeline around the wheel position', () => {
    const { root, panel } = mount()
    const many: UINode[] = Array.from({ length: 10 }, (_, index) => ({
      kind: 'user',
      id: `u${index}`,
      seq: index + 1,
      content: [{ type: 'text', text: `input ${index}` }],
    }))
    panel.render(many)
    const mode = root.querySelector<HTMLSelectElement>('#trace-timeline-mode') as HTMLSelectElement
    mode.value = 'sequence'
    flushSync(() => mode.dispatchEvent(new Event('change', { bubbles: true })))
    const track = root.querySelector<HTMLElement>('.trace-gantt-track') as HTMLElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 10,
      width: 100,
      height: 10,
      toJSON: () => ({}),
    })
    const initial = Number.parseFloat(
      (root.querySelector('[data-target-id="u5"]') as HTMLElement).style.width,
    )
    flushSync(() =>
      root
        .querySelector('.trace-gantt')
        ?.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 50, deltaY: -1000 }),
        ),
    )
    const zoomed = Number.parseFloat((root.querySelector('[data-target-id="u5"]') as HTMLElement).style.width)
    expect(zoomed).toBeGreaterThan(initial)
  })

  it('keeps manual timeline zoom away from a selected row until that row is selected again', () => {
    const { root, panel } = mount()
    const many: UINode[] = Array.from({ length: 10 }, (_, index) => ({
      kind: 'user',
      id: `u${index}`,
      seq: index + 1,
      content: [{ type: 'text', text: `input ${index}` }],
    }))
    panel.render(many)
    const mode = root.querySelector<HTMLSelectElement>('#trace-timeline-mode') as HTMLSelectElement
    mode.value = 'sequence'
    flushSync(() => mode.dispatchEvent(new Event('change', { bubbles: true })))
    const track = root.querySelector<HTMLElement>('.trace-gantt-track') as HTMLElement
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 10,
      width: 100,
      height: 10,
      toJSON: () => ({}),
    })
    root.querySelector<HTMLButtonElement>('[data-target-id="u0"]')?.click()
    expect(root.querySelector('.trace-row[aria-current="true"]')?.getAttribute('data-trace-row-id')).toBe(
      'u0',
    )
    flushSync(() =>
      root
        .querySelector('.trace-gantt')
        ?.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 50, deltaY: -1000 }),
        ),
    )
    expect(root.querySelector('[data-target-id="u0"]')).toBeNull()
    expect(root.querySelector('[data-target-id="u5"]')).not.toBeNull()
    expect(root.querySelector('.trace-row[aria-current="true"]')?.getAttribute('data-trace-row-id')).toBe(
      'u0',
    )

    root.querySelector<HTMLButtonElement>('[data-trace-row-id="u0"]')?.click()
    expect(root.querySelector('[data-target-id="u0"]')).not.toBeNull()
  })

  it('virtualizes long histories, preserves the top record on prepend, and reveals a selected distant record', () => {
    const { root, panel } = mount()
    const history: UINode[] = Array.from({ length: 240 }, (_, index) => ({
      kind: 'user',
      id: `r${index}`,
      seq: index + 21,
      content: [{ type: 'text', text: `record ${index}` }],
    }))
    panel.render(history)
    const list = root.querySelector<HTMLElement>('.trace-list') as HTMLElement
    expect(root.querySelectorAll('.trace-row').length).toBeLessThan(100)
    expect(root.querySelector('[data-trace-row-id="r239"]')).not.toBeNull()
    list.scrollTop = 32 * 60
    list.dispatchEvent(new Event('scroll', { bubbles: true }))
    const older: UINode[] = Array.from({ length: 20 }, (_, index) => ({
      kind: 'user',
      id: `older${index}`,
      seq: index + 1,
      content: [{ type: 'text', text: `older ${index}` }],
    }))
    panel.render([...older, ...history])
    expect(list.scrollTop).toBe(32 * 80)
    const mode = root.querySelector<HTMLSelectElement>('#trace-timeline-mode') as HTMLSelectElement
    mode.value = 'sequence'
    flushSync(() => mode.dispatchEvent(new Event('change', { bubbles: true })))
    root.querySelector<HTMLButtonElement>('[data-target-id="r239"]')?.click()
    expect(root.querySelector('.trace-row[aria-current="true"]')?.getAttribute('data-trace-row-id')).toBe(
      'r239',
    )
  })

  it('bounds timeline DOM nodes while keeping dense regions clickable', () => {
    const { root, panel } = mount()
    const history: UINode[] = Array.from({ length: 3000 }, (_, index) => ({
      kind: 'user',
      id: `dense${index}`,
      seq: index + 1,
      content: [{ type: 'text', text: `dense ${index}` }],
    }))
    panel.render(history)
    const mode = root.querySelector<HTMLSelectElement>('#trace-timeline-mode') as HTMLSelectElement
    mode.value = 'sequence'
    flushSync(() => mode.dispatchEvent(new Event('change', { bubbles: true })))
    expect(root.querySelectorAll('.trace-row').length).toBeLessThan(100)
    expect(root.querySelectorAll('.trace-gantt-bar').length).toBeLessThanOrEqual(600)
    const cluster = root.querySelector<HTMLButtonElement>('.trace-gantt-bar.cluster') as HTMLButtonElement
    expect(cluster?.dataset.count).toBeTruthy()
    cluster.click()
    expect(root.querySelector('.trace-row[aria-current="true"]')).not.toBeNull()
  })

  it('keeps the top visible when loading earlier records from a short history', () => {
    const { root, panel } = mount()
    const current: UINode[] = Array.from({ length: 10 }, (_, index) => ({
      kind: 'user',
      id: `recent${index}`,
      seq: index + 51,
      content: [{ type: 'text', text: `recent ${index}` }],
    }))
    const older: UINode[] = Array.from({ length: 50 }, (_, index) => ({
      kind: 'user',
      id: `older${index}`,
      seq: index + 1,
      content: [{ type: 'text', text: `older ${index}` }],
    }))
    const loadEarlier = vi.fn()
    panel.render(current, [], { hasEarlier: true, loadEarlier, sessionId: 's' })
    root.querySelector<HTMLButtonElement>('.trace-load-earlier')?.click()
    expect(loadEarlier).toHaveBeenCalledOnce()
    panel.render([...older, ...current], [], { hasEarlier: false, sessionId: 's' })
    const list = root.querySelector<HTMLElement>('.trace-list') as HTMLElement
    expect(list.scrollTop).toBe(0)
    expect(root.querySelector('[data-trace-row-id="older0"]')).not.toBeNull()
  })
})
