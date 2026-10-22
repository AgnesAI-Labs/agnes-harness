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
  document.documentElement.lang = ''
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
  toggle.setAttribute('role', 'tab')
  chat.setAttribute('role', 'tab')
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

/** Timeline modes live in the toolbar's ⋯ menu. */
function chooseTimelineMode(root: HTMLElement, mode: string) {
  flushSync(() => root.querySelector<HTMLButtonElement>('[data-testid="trace-toolbar-more"]')?.click())
  const item = document.querySelector<HTMLElement>(`[data-testid="trace-timeline-${mode}"]`)
  if (!item) throw new Error(`timeline mode ${mode} is not in the menu`)
  flushSync(() => item.click())
}

const search = (root: HTMLElement, value: string) => {
  const input = root.querySelector('.trace-search') as HTMLInputElement
  input.value = value
  flushSync(() =>
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })),
  )
}

describe('trace panel', () => {
  it('renders event previews, gantt lanes and stats from nodes and turns', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const text = root.textContent ?? ''
    expect(text).toContain('User')
    expect(text).toContain('你好')
    expect(text).toContain('Context')
    expect(text).not.toContain('Current runtime context')
    expect(text).toContain('Assistant')
    expect(text).toContain('我先看一下工作目录')
    expect(text).toContain('Tool')
    expect(text).toContain('Run command')
    expect(text).toContain('Input')
    expect(text).toContain('Model')
    expect(text).toContain('Duration')
    expect(text).toContain('Turns 1')
    expect(text).toContain('Calls 2')
    expect(root.textContent).toContain('Turn 1')
    const modelBars = [...root.querySelectorAll('.trace-gantt-bar.lane-model')] as HTMLElement[]
    const toolBars = [...root.querySelectorAll('.trace-gantt-bar.lane-tool')] as HTMLElement[]
    expect(modelBars.length).toBeGreaterThan(0)
    expect(toolBars.length).toBeGreaterThan(0)
    expect(modelBars.some((bar) => Number.parseFloat(bar.style.width) > 8)).toBe(true)
  })

  it('shows empty state and does not throw when there are no nodes', () => {
    const { root, panel } = mount()
    expect(() => panel.render([], [turn()])).not.toThrow()
    expect(root.textContent).toContain('Send a task to see timing for each step.')
  })

  it('switches to the trace view and persists without calling projectUI', () => {
    const { root, toggle, chat, conversation, panel, projectUI } = mount(false)
    panel.setOpen(true)
    expect(toggle.hasAttribute('aria-pressed')).toBe(false)
    expect(chat.hasAttribute('aria-pressed')).toBe(false)
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
    root.querySelector<HTMLButtonElement>('[data-trace-row-id="t1"]')?.click()
    expect(root.querySelector<HTMLElement>('.trace-inspector')?.hidden).toBe(false)
    // The tool exposes each reader view; debug views remain in ⋯.
    expect([...root.querySelectorAll('.trace-tab')].map((tab) => tab.textContent).sort()).toEqual([
      'Arguments',
      'Result',
      'Source',
    ])
    expect(root.querySelector('.trace-inspector-title')?.textContent).toBe('Run command')
    root.querySelector<HTMLButtonElement>('[data-pane="args"]')?.click()
    expect(root.querySelector('.trace-inspector-pane')?.textContent).toContain('"command":"ls"')
    root.querySelector<HTMLButtonElement>('[data-pane="source"]')?.click()
    expect(root.querySelector('.trace-inspector-pane')?.textContent).toContain('Tool · bash')
    flushSync(() => root.querySelector<HTMLButtonElement>('[data-testid="trace-inspector-more"]')?.click())
    const projected = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Projected content',
    )
    flushSync(() => projected?.click())
    expect(root.querySelector('.trace-inspector-pane')?.textContent).toContain('may be truncated')
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
    root.querySelector<HTMLButtonElement>('[data-pane="args"]')?.click()
    // Arguments remain available after opening on the recorded result.
    await vi.waitFor(() =>
      expect(readToolDetail).toHaveBeenCalledWith('session-one', 4, 5, expect.any(AbortSignal)),
    )
    await vi.waitFor(() =>
      expect(root.querySelector('.trace-inspector-pane:not([hidden])')?.textContent).toContain(
        'echo complete input',
      ),
    )
    root.querySelector<HTMLButtonElement>('[data-pane="result"]')?.click()
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

  it('opens a failed tool on its result and shows the recorded error before the full read', async () => {
    const readToolDetail = vi.fn().mockResolvedValue({
      call: { toolUseId: 'call-1', name: 'bash', args: { command: 'npx serve .' }, ordinal: 0 },
    })
    const { root, panel } = mount(true, readToolDetail)
    const failed = nodes.map((node) =>
      node.kind === 'tool' ? { ...node, status: 'failed' as const, resultPreview: 'exit 127' } : node,
    )
    const trace = {
      ...sampleTrace,
      children: sampleTrace.children.map((span) =>
        span.kind === 'tool'
          ? { ...span, status: 'failed' as const, error: { code: 'EXIT', message: 'npx: command not found' } }
          : span,
      ),
    }
    panel.render(failed, [turn(trace, ['u1', 'c1', 'a1', 't1'])], { hasEarlier: false, sessionId: 's' })
    root.querySelector<HTMLButtonElement>('[data-trace-row-id="t1"]')?.click()
    const pane = () => root.querySelector('.trace-inspector-pane:not([hidden])')
    expect(pane()?.querySelector('[data-testid="trace-tool-error"]')?.textContent).toContain(
      'npx: command not found',
    )
    await vi.waitFor(() => expect(readToolDetail).toHaveBeenCalled())
    await vi.waitFor(() => expect(pane()?.textContent).toContain('not recorded yet'))
    expect(pane()?.textContent).toContain('npx: command not found')
  })

  it('shows unknown duration for a completed tool without a recorded span', () => {
    const { root, panel } = mount(true, vi.fn().mockReturnValue(new Promise(() => {})))
    panel.render(nodes, [turn(undefined, ['u1', 'c1', 'a1', 't1'])], {
      hasEarlier: false,
      sessionId: 'session-one',
    })
    root.querySelector<HTMLButtonElement>('[data-trace-row-id="t1"]')?.click()
    const timing = root.querySelector('[data-testid="trace-facts"]')?.textContent
    expect(timing).toContain('Duration unknown')
    expect(timing).not.toContain('In progress')
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
    const { root, panel, toggle } = mount(true, readToolDetail)
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])], {
      hasEarlier: false,
      sessionId: 'old',
    })
    root.querySelector<HTMLButtonElement>('[data-trace-row-id="t1"]')?.click()
    ;[...root.querySelectorAll<HTMLButtonElement>('.trace-tab')]
      .find((tab) => tab.textContent === 'Arguments')
      ?.click()
    await vi.waitFor(() => expect(readToolDetail).toHaveBeenCalledTimes(1))
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])], {
      hasEarlier: false,
      sessionId: 'new',
    })
    // Another session opens on its own view (the conversation); open its trace as a person would.
    flushSync(() => toggle.click())
    expect(root.querySelector('.trace-inspector')?.hasAttribute('hidden')).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-trace-row-id="t1"]')?.click()
    ;[...root.querySelectorAll<HTMLButtonElement>('.trace-tab')]
      .find((tab) => tab.textContent === 'Arguments')
      ?.click()
    await vi.waitFor(() => expect(readToolDetail).toHaveBeenCalledTimes(2))
    resolveOld?.({
      call: { toolUseId: 'call-1', name: 'bash', args: { command: 'old session' }, ordinal: 0 },
    })
    const input = [...root.querySelectorAll<HTMLButtonElement>('.trace-tab')].find(
      (tab) => tab.textContent === 'Arguments',
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
    // The header names the turn, quotes what you asked, then counts records and time.
    const header = root.querySelector('.trace-turn-toggle')
    expect(header?.textContent).toBe('Turn 1“你好”4 records · 80 ms')
    expect(header?.getAttribute('aria-label')).toBe('Turn 1 · 4 records')
    expect(row.children[0]?.classList.contains('trace-step-mark')).toBe(true)
    expect(row.children[1]?.classList.contains('trace-badge')).toBe(true)
    expect(row.children[2]?.classList.contains('trace-row-preview')).toBe(true)
    expect(row.children[3]?.classList.contains('trace-row-end')).toBe(true)
    // A tool row reads as words with its status and duration on the right; no raw JSON.
    const tool = root.querySelector('[data-trace-row-id="t1"]')
    expect(tool?.querySelector('.trace-row-text')?.textContent).toBe('Run command')
    expect(tool?.querySelector('.trace-preview-raw')).toBeNull()
    expect(tool?.querySelector('.trace-row-status')?.getAttribute('data-status')).toBe('completed')
    expect(tool?.querySelector('.trace-row-duration')?.textContent).toBe('20 ms')
  })

  it('folds a turn, reveals search matches, and expands it for timeline selection', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const fold = root.querySelector<HTMLButtonElement>('.trace-turn-toggle') as HTMLButtonElement
    fold.click()
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(root.querySelectorAll('.trace-row')).toHaveLength(0)
    search(root, 'ls')
    // A search opens folded turns so every match can be seen and stepped to.
    expect(root.querySelectorAll('.trace-row').length).toBeGreaterThan(0)
    search(root, '')
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
    expect(foldAll.getAttribute('aria-label')).toBe('Expand all turns')
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
    search(root, 'child_tool')
    expect(root.querySelector('[data-trace-row-id="child-tool"]')).not.toBeNull()
    search(root, '')
    expect(root.querySelector('[data-trace-row-id="child-tool"]')).toBeNull()
    chooseTimelineMode(root, 'sequence')
    root.querySelector<HTMLButtonElement>('[data-target-id="child-tool"]')?.click()
    expect(root.querySelector('[data-trace-row-id="child-tool"]')).not.toBeNull()
    expect(root.querySelector('.trace-tool-toggle')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the empty state hidden until the panel has been given records, then shows it for none', () => {
    const { root, panel } = mount()
    const empty = () => root.querySelector<HTMLElement>('.trace-empty')
    // A switched session remounts the panel before its first records arrive: nothing to announce yet.
    expect(empty()?.hidden).toBe(true)
    // A session without records opens on the conversation; opening the trace then announces the lack.
    panel.render([], [])
    panel.setOpen(true)
    expect(empty()?.hidden).toBe(false)
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    expect(empty()?.hidden).toBe(true)
  })

  it('marks search matches, counts them and steps through them without hiding other records', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    search(root, 'run')
    expect(root.querySelectorAll('.trace-row')).toHaveLength(4)
    expect(root.querySelector('[data-testid="trace-search-count"]')?.textContent).toBe('1 / 2')
    expect(root.querySelector('[data-trace-row-id="t1"] mark')?.textContent).toBe('Run')
    expect(root.querySelector('[data-match="current"]')?.getAttribute('data-trace-row-id')).toBe('c1')
    const input = root.querySelector('.trace-search') as HTMLInputElement
    flushSync(() => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
    expect(root.querySelector('[data-testid="trace-search-count"]')?.textContent).toBe('2 / 2')
    expect(root.querySelector('[data-match="current"]')?.getAttribute('data-trace-row-id')).toBe('t1')
    flushSync(() =>
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', shiftKey: true })),
    )
    expect(root.querySelector('[data-testid="trace-search-count"]')?.textContent).toBe('1 / 2')
    // Stepped to t1; hiding the user rows with a type chip must not move the current match.
    flushSync(() => input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
    flushSync(() => root.querySelector<HTMLButtonElement>('.trace-chip[data-kind="tool"]')?.click())
    expect(root.querySelector('[data-match="current"]')?.getAttribute('data-trace-row-id')).toBe('t1')
    flushSync(() => root.querySelector<HTMLButtonElement>('.trace-chip[data-kind="all"]')?.click())
    flushSync(() =>
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', shiftKey: true })),
    )
    search(root, 'nothing-here')
    expect(root.querySelector('[data-testid="trace-search-count"]')?.textContent).toBe('0 / 0')
    // ⌘F focuses the search while the trace is showing.
    input.blur()
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'f', metaKey: true }))
    expect(document.activeElement).toBe(input)
  })

  it('filters by several type chips at once and counts each type', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    const chip = (kind: string) => root.querySelector<HTMLButtonElement>(`.trace-chip[data-kind="${kind}"]`)
    const toggle = () => root.querySelector<HTMLButtonElement>('[data-testid="trace-chips-toggle"]')
    expect(chip('all')?.getAttribute('aria-pressed')).toBe('true')
    expect(chip('tool')?.textContent).toBe('Tool1')
    expect(chip('approval')).toBeNull()
    // Four types fit the folded row, so there is nothing to expand.
    expect(toggle()).toBeNull()
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
    // A fifth type folds the last one behind "Show all".
    expect(chip('context')).toBeNull()
    expect(toggle()?.textContent).toBe('Show all +1')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
    flushSync(() => toggle()?.click())
    expect(chip('context')?.textContent).toBe('Context1')
    // A pressed chip stays in view after the row folds again, leaving nothing to expand.
    flushSync(() => chip('context')?.click())
    flushSync(() => toggle()?.click())
    expect(chip('context')?.getAttribute('aria-pressed')).toBe('true')
    expect(toggle()).toBeNull()
    flushSync(() => chip('context')?.click())
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    flushSync(() => chip('tool')?.click())
    flushSync(() => chip('assistant')?.click())
    expect(
      [...root.querySelectorAll('.trace-row')].map((row) => row.getAttribute('data-trace-row-id')),
    ).toEqual(['a1', 't1'])
    expect(chip('all')?.getAttribute('aria-pressed')).toBe('false')
    // Folding is a whole-list action, so it waits while the list is narrowed.
    expect(root.querySelector<HTMLButtonElement>('.trace-fold-all')?.disabled).toBe(true)
    flushSync(() => chip('all')?.click())
    expect(root.querySelectorAll('.trace-row')).toHaveLength(4)
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
    expect(root.querySelector('.trace-row')?.textContent).toContain('1 image · 1 resource link')
    ;(root.querySelector('.trace-row') as HTMLButtonElement).click()
    expect(root.querySelector('.trace-inspector')?.textContent).toContain('Image · image/png')
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
    const shell = nodes[3] as Extract<UINode, { kind: 'tool' }>
    // A readable recorded summary stays in the row; exact arguments remain in the inspector.
    panel.render([{ ...shell, name: 'custom_tool' }], [turn(sampleTrace, ['t1'])])
    const tool = root.querySelector('[data-trace-row-id="t1"]')
    expect(tool?.querySelector('.trace-row-text')?.textContent).toBe('列出文件')
    expect(tool?.querySelector('.trace-preview-raw')).toBeNull()
    root.querySelector<HTMLButtonElement>('[data-trace-row-id="t1"]')?.click()
    root.querySelector<HTMLButtonElement>('[data-pane="args"]')?.click()
    expect(root.querySelector('.trace-inspector-pane')?.textContent).toContain('"command":"ls"')
  })

  it('preserves user and context tones in the input gantt lane', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    expect(root.querySelector('.trace-gantt-bar.tone-user')).not.toBeNull()
    expect(root.querySelector('.trace-gantt-bar.tone-context')).not.toBeNull()
    expect((root.querySelector('.trace-gantt-bar.tone-user') as HTMLElement).style.width).toBe('0%')
    expect(root.querySelector('.trace-gantt-bar.tone-user')?.getAttribute('title')).toContain(
      'anchored at the turn start',
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
    expect(assistant?.textContent).toContain('Failed')
    expect(assistant?.textContent).toContain('MODEL_TIMEOUT')
    assistant?.click()
    const inspector = root.querySelector('.trace-inspector')
    // The title says what happened; status, turn and step sit on the line under it.
    expect(inspector?.querySelector('.trace-inspector-title')?.textContent).toBe('Model request · k3')
    expect(inspector?.querySelector('.trace-status-tag')?.textContent).toBe('Failed')
    expect(inspector?.querySelector('.trace-inspector-meta')?.textContent).toContain('Turn 1Step 1')
    expect(inspector?.querySelector('[data-testid="trace-facts"]')?.textContent).toContain(
      'Input / output7 / 3',
    )
    expect([...root.querySelectorAll('.trace-tab')].map((tab) => tab.textContent)).toEqual([
      'Reply',
      'Usage',
      'Source',
    ])
    root.querySelector<HTMLButtonElement>('[data-pane="source"]')?.click()
    expect(inspector?.textContent).toContain('Error codeMODEL_TIMEOUT')
    root.querySelector<HTMLButtonElement>('[data-pane="usage"]')?.click()
    expect(inspector?.textContent).toContain('Turn usageInput 12 · Output 5')
    expect(inspector?.textContent).toContain('This callInput 7 · Output 3')
    expect(inspector?.textContent).toContain('Request order1')
    expect(inspector?.textContent).toContain('Ledger order1')
    expect(inspector?.textContent).toContain('Cumulative billed usageInput 7 · Output 3')
    panel.render(
      [nodes[0] as UINode, nodes[2] as UINode],
      [
        {
          ...activeTurn,
          usage: { ...activeTurn.usage, reasoningComplete: false },
        },
      ],
    )
    expect(root.querySelector('.trace-inspector')?.textContent).toContain('Reasoning Not provided')
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
    expect(root.querySelector('.trace-inspector')?.textContent).not.toContain('This call')
  })

  it('selects the linked record from the time overview, including a filtered record', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    flushSync(() => root.querySelector<HTMLButtonElement>('.trace-chip[data-kind="tool"]')?.click())
    expect(root.querySelector('[data-trace-row-id="a1"]')).toBeNull()
    const model = root.querySelector<HTMLButtonElement>('.trace-gantt-bar.lane-model')
    expect(model?.dataset.targetId).toBe('a1')
    model?.click()
    expect(root.querySelector('.trace-chip[data-kind="all"]')?.getAttribute('aria-pressed')).toBe('true')
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
    expect(modelBar?.getAttribute('title')).toContain('In progress')
    const row = [...root.querySelectorAll('.trace-row')].find((item) =>
      item.textContent?.includes('我先看一下'),
    )
    ;(row as HTMLButtonElement | undefined)?.click()
    expect(root.querySelector('.trace-inspector')?.textContent).toContain('In progress')
    expect(root.querySelector('.trace-inspector')?.textContent).not.toContain('0 ms')
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
    expect(root.textContent).toContain('7 child steps omitted')
    expect(root.textContent).not.toContain('Failed')
    expect(root.textContent).toContain('Calls 2')
    expect(root.querySelector('.trace-gantt-bar.truncated')?.getAttribute('title')).toBe(
      '7 child steps omitted',
    )
  })

  it('marks a partially loaded session and loads earlier records on request', () => {
    const { root, panel } = mount()
    const loadEarlier = vi.fn()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])], { hasEarlier: true, loadEarlier })
    expect(root.textContent).toContain('Partially loaded')
    ;(root.querySelector('.trace-load-earlier') as HTMLButtonElement).click()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    expect(root.textContent).not.toContain('Partially loaded')
    expect(root.querySelector('.trace-load-earlier')).toBeNull()
  })

  it('filters the ledger by a dragged timeline interval and resets it with Escape', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    chooseTimelineMode(root, 'sequence')
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
    chooseTimelineMode(root, 'sequence')
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
    chooseTimelineMode(root, 'sequence')
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
    chooseTimelineMode(root, 'sequence')
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
    chooseTimelineMode(root, 'sequence')
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
    chooseTimelineMode(root, 'sequence')
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

  it('repaints badges and stats when the page language changes', () => {
    const { root, panel } = mount()
    panel.render(nodes, [turn(sampleTrace, ['u1', 'c1', 'a1', 't1'])])
    expect(root.textContent).toContain('User')
    expect(root.textContent).toContain('Turns 1')
    document.documentElement.lang = 'zh-CN'
    flushSync(() => window.dispatchEvent(new CustomEvent('agnes:locale-changed')))
    expect(root.textContent).toContain('用户')
    expect(root.textContent).toContain('轮次 1')
    document.documentElement.lang = ''
    flushSync(() => window.dispatchEvent(new CustomEvent('agnes:locale-changed')))
    expect(root.textContent).toContain('User')
    expect(root.textContent).toContain('Turns 1')
  })
})

it('shows projected business UI revisions and action outcomes in the ordinary trace list', () => {
  const business = {
    ...sampleTrace,
    children: [
      ...sampleTrace.children,
      {
        id: 'ui-fact:8',
        kind: 'other' as const,
        name: 'surface.updated · r2 · Finance',
        status: 'completed' as const,
        startSeq: 8,
        startedAt: sampleTrace.startedAt,
        children: [],
      },
      {
        id: 'ui-fact:9',
        kind: 'other' as const,
        name: 'action.failed · r2',
        status: 'failed' as const,
        startSeq: 9,
        startedAt: sampleTrace.startedAt,
        children: [],
      },
    ],
  }
  const rows = traceRowBuilder.build(nodes, [turn(business)])
  expect(rows.filter((row) => row.kind === 'ui').map((row) => [row.preview, row.statusCode])).toEqual([
    ['Updated · Finance · revision 2', 'completed'],
    ['Action failed · Finance · revision 2', 'failed'],
  ])
  // Business-UI rows name the plugin, never its internal id.
  expect(rows.find((row) => row.kind === 'ui')?.source).toBe('Business UI (built-in plugin)')
})
