import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
/** @vitest-environment happy-dom */

import type { UINode, UITurn } from '@agnes/protocol'
import { ConversationMessages, type ConversationMessagesProps } from '@agnes/web-ui/conversation'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activitySummary,
  shortenHome,
  thoughtLine,
  toolKind,
  toolStep,
} from '../src/conversation/messages/tool-step.js'
import { webSources } from '../src/conversation/messages/web-sources.js'
import { webUiLocaleCatalog } from '../src/locales/index.js'
import { approvalSummary, baseToolTitle } from '../src/tool-presentation.js'

const translate =
  (locale: 'zh-CN' | 'en'): ConversationMessagesProps['t'] =>
  (key, vars) =>
    Object.entries(vars ?? {}).reduce(
      (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
      webUiLocaleCatalog[locale]?.[key] ?? key,
    )
const t = translate('zh-CN')

type Tool = Extract<UINode, { kind: 'tool' }>
let seq = 1
const tool = (id: string, name: string, args: object, extra: Partial<Tool> = {}): Tool => ({
  kind: 'tool',
  id,
  seq: seq++,
  toolUseId: id,
  name,
  status: 'completed',
  summary: name,
  argsPreview: JSON.stringify(args),
  ...extra,
})
const say = (id: string, text: string, extra: object = {}): UINode => ({
  kind: 'assistant',
  id,
  seq: seq++,
  text,
  ...extra,
})
const user: UINode = { kind: 'user', id: 'user', seq: 0, content: [{ type: 'text', text: '看看工作区' }] }
const turn = (nodes: readonly UINode[], extra: Partial<UITurn> = {}): UITurn => ({
  id: 'turn:1',
  turn: 1,
  startSeq: 0,
  startedAt: '2026-10-01T00:00:00.000Z',
  status: 'running',
  nodeIds: nodes.map((node) => node.id),
  inherited: false,
  forkable: false,
  usage: {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: true,
    billingComplete: true,
    calls: [],
  },
  ...extra,
})

describe('step naming', () => {
  it('names a call by what it did and the one thing it acted on', () => {
    expect(
      toolStep(tool('a', 'shell', { command: 'ls -la\necho done', description: 'List files' }), t),
    ).toMatchObject({ kind: 'command', verb: '运行命令', target: 'List files', command: 'ls -la\necho done' })
    expect(toolStep(tool('b', 'shell', { command: 'ls -la\necho done' }), t).target).toBe('')
    expect(
      toolStep(tool('c', 'read', { path: `${['', 'Users', 'someone'].join('/')}/work/a.md` }), t),
    ).toMatchObject({
      kind: 'read',
      verb: '读取',
      target: '~/work/a.md',
    })
    expect(toolStep(tool('d', 'grep', { pattern: 'TODO', path: '.' }), t)).toMatchObject({
      verb: '搜索内容',
      target: 'TODO',
    })
    expect(toolStep(tool('e', 'edit', { path: 'src/a.ts' }), t).verb).toBe('编辑')
    expect(toolStep(tool('f', 'web_search', { queries: ['one', 'two'] }), t)).toMatchObject({
      kind: 'web',
      verb: '搜索网页',
      target: 'one · two',
    })
    expect(toolStep(tool('g', 'plugin_hello_tool', { message: 'hi' }), t)).toMatchObject({
      kind: 'tool',
      verb: '执行操作',
      target: '',
    })
    expect(toolStep(tool('h', 'ask_user_question', {}), t, { name: '提问' })).toMatchObject({
      verb: '提问',
      target: '',
    })
  })

  it('reads the target from an argument preview that was clipped mid-JSON', () => {
    const clipped = `{"command":"pnpm test --run \\"fast\\"","content":"${'x'.repeat(40)}`
    expect(toolStep(tool('a', 'shell', {}, { argsPreview: clipped }), t).command).toBe(
      'pnpm test --run "fast"',
    )
    expect(toolStep(tool('b', 'read', {}, { argsPreview: 'not json' }), t).target).toBe('')
  })

  it('classifies tool names and shortens only a home prefix', () => {
    expect(['ls', 'read_file', 'apply_patch', 'web_fetch', 'job_list'].map(toolKind)).toEqual([
      'list',
      'read',
      'edit',
      'web',
      'tool',
    ])
    expect(shortenHome(['', 'home', 'me', 'x'].join('/'))).toBe('~/x')
    expect(shortenHome('/opt/Users/me/x')).toBe('/opt/Users/me/x')
    expect(thoughtLine('## Plan\n\n- first step\nsecond')).toBe('Plan')
    expect(thoughtLine('first\nlatest line\n', true)).toBe('latest line')
  })

  it('summarises consecutive steps in the order they first happened', () => {
    expect(activitySummary(['read', 'read', 'command', 'read', 'command'], t)).toBe(
      '已读取 3 个文件，运行了 2 条命令',
    )
    expect(activitySummary(['search'], t)).toBe('已搜索代码')
    expect(activitySummary(['thinking', 'command', 'thinking'], t)).toBe('运行了命令')
    expect(activitySummary(['thinking', 'thinking'], t)).toBe('已思考')
    expect(activitySummary(['read', 'command', 'command'], translate('en'))).toBe(
      'Read a file, ran 2 commands',
    )
  })

  it('lists the pages of a web search and ignores text in any other shape', () => {
    expect(
      webSources(
        '[q] First\nhttps://www.example.com/a\nline one\nline two\n\n[q] Bad\njavascript:alert(1)\nx',
      ),
    ).toEqual([
      { title: 'First', url: 'https://www.example.com/a', site: 'example.com', snippet: 'line one line two' },
    ])
    expect(webSources('no search results')).toEqual([])
  })
})

describe('turn timeline', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  const render = (
    nodes: readonly UINode[],
    current: UITurn,
    extra: Partial<ConversationMessagesProps> = {},
  ) =>
    act(async () =>
      root.render(createElement(ConversationMessages, { t, nodes, turns: [current], ...extra })),
    )
  const wrapper = (id: string) => host.querySelector<HTMLElement>(`[data-node-id="${id}"]`)?.parentElement
  const groups = () => [...host.querySelectorAll<HTMLElement>('.turn-activity:not([hidden])')]
  const click = (element: Element | null | undefined) =>
    act(async () => (element as HTMLElement | null)?.click())

  it.each(['zh-CN', 'en'] as const)(
    'keeps blocked answers visible with one collapsed explanation (%s)',
    async (locale) => {
      const retry = vi.fn()
      const nodes = [
        user,
        say('draft', 'Available evidence.'),
        say('answer', 'Still needs an independent check.'),
      ]
      await render(
        nodes,
        turn(nodes, {
          status: 'failed',
          reason: 'blocked',
          verification: 'blocked',
          finalAssistantId: 'answer',
          endedAt: '2026-10-01T00:00:01.000Z',
        }),
        {
          t: translate(locale),
          renderTurnActions: (_turn, _text, settled) =>
            settled ? createElement('button', { type: 'button', onClick: retry }, 'Retry') : null,
        },
      )
      expect(wrapper('draft')?.hidden).toBe(false)
      expect(wrapper('answer')?.hidden).toBe(false)
      const notes = host.querySelectorAll('[data-testid="turn-verification"]')
      expect(notes).toHaveLength(1)
      expect(notes[0]?.getAttribute('data-open')).toBe('false')
      expect(notes[0]?.getAttribute('data-variant')).toBe('plain')
      expect(notes[0]?.querySelector('.agh-disclosure-chevron')).not.toBeNull()
      expect(notes[0]?.querySelector('.agh-disclosure-marker')).toBeNull()
      expect(host.querySelector('[data-testid="turn-timing"]')?.textContent).toContain(
        locale === 'en' ? 'Not verified' : '未通过校验',
      )
      expect(host.textContent).not.toContain(locale === 'en' ? 'Failed' : '执行失败')
      expect(notes[0]?.textContent).toContain(
        locale === 'en' ? 'automatic correction has stopped' : '回答仍未通过校验',
      )
      expect(host.querySelector('.turn-error')).toBeNull()
      expect(host.textContent).not.toContain('blocked')
      const retryButton = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry',
      )
      expect(retryButton?.disabled).toBe(false)
      await click(retryButton)
      expect(retry).toHaveBeenCalled()
    },
  )
  it.each(['unavailable', 'unverified'] as const)(
    'distinguishes completed answers whose verification is %s',
    async (verification) => {
      const nodes = [user, say('answer', 'Available answer.')]
      await render(
        nodes,
        turn(nodes, {
          status: 'completed',
          reason: 'completed',
          verification,
          finalAssistantId: 'answer',
          endedAt: '2026-10-01T00:00:01.000Z',
        }),
      )
      const note = host.querySelector('[data-testid="turn-verification"]')
      expect(note?.getAttribute('data-open')).toBe('false')
      expect(note?.getAttribute('data-variant')).toBe('plain')
      expect(host.querySelector('[data-testid="turn-timing"]')?.textContent).toContain(
        verification === 'unavailable' ? '未能完成校验' : '未通过校验',
      )
      expect(note?.textContent).toContain(verification === 'unavailable' ? '未能完成校验' : '完成校验未通过')
      expect(wrapper('answer')?.hidden).toBe(false)
      expect(host.querySelector('.turn-error')).toBeNull()
    },
  )

  it.each(['blocked', 'unavailable'] as const)(
    'keeps real execution errors visible after a prior %s verification fact',
    async (verification) => {
      const nodes = [user, say('answer', 'Available answer.')]
      await render(
        nodes,
        turn(nodes, {
          status: 'failed',
          reason: 'error',
          verification,
          error: { code: 'E_RUNTIME', message: 'Execution stopped unexpectedly' },
          finalAssistantId: 'answer',
          endedAt: '2026-10-01T00:00:01.000Z',
        }),
      )
      expect(host.querySelector('[data-testid="turn-timing"]')?.textContent).toContain('执行失败')
      expect(host.querySelector('.turn-error')?.textContent).toContain('E_RUNTIME')
      expect(host.querySelector('[data-testid="turn-verification"]')).toBeNull()
      expect(host.querySelector('.conversation-turn')?.hasAttribute('data-verification')).toBe(false)
    },
  )

  it.each([true, false])(
    'shows one collapsed recovery note and retains raw attempts (visual=%s)',
    async (visual) => {
      const attempts = [false, true].map((disabled, i) =>
        tool(
          `invalid-${i}`,
          visual ? 'ui_render' : 'fixture_lookup',
          {},
          {
            status: 'failed',
            resultPreview: 'TOOL_ARGS_INVALID: /surface/revision minimum=1',
            argumentRecovery: { disabled, presentational: visual },
          },
        ),
      )
      const nodes = [user, ...attempts, say('answer', '调查结论：继续检查试验数据。')]
      await render(
        nodes,
        turn(nodes, { status: 'completed', finalAssistantId: 'answer', endedAt: '2026-10-01T00:00:01.000Z' }),
      )
      const notes = host.querySelectorAll('[data-testid="tool-argument-recovery"]')
      expect(notes).toHaveLength(1)
      const note = notes[0]!
      expect(note.textContent).toContain(visual ? '界面组件生成失败，已改用文字回答' : '一项操作暂未完成')
      expect(note.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
      expect(host.querySelector('.turn-final')?.textContent).toContain('调查结论')
      expect(host.querySelector('.turn-final')?.textContent).not.toContain('TOOL_ARGS_INVALID')
      await click(note.querySelector('button[aria-expanded]'))
      expect(note.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true')
      expect(note.textContent).toContain('TOOL_ARGS_INVALID')
      expect(note.textContent).toContain(visual ? 'ui_render' : 'fixture_lookup')
    },
  )

  it('includes nested validation failures in the same collapsed technical record', async () => {
    const nodes = [user, say('answer', '文字结论')]
    await render(
      nodes,
      turn(nodes, {
        status: 'completed',
        finalAssistantId: 'answer',
        argumentRecovery: [
          {
            name: 'recovery_probe',
            seq: 2,
            disabled: true,
            presentational: false,
            hint: 'Disabled for the rest of this turn',
          },
        ],
      }),
    )
    const note = host.querySelector('[data-testid="tool-argument-recovery"]')
    expect(note?.textContent).toContain('一项操作暂未完成')
    expect(note?.textContent).toContain('recovery_probe')
    expect(note?.getAttribute('data-open')).toBe('false')
  })

  it.each([false, true])(
    'shows workflow prose and tool results without a final assistant reference (live=%s)',
    async (live) => {
      const nodes = [
        user,
        tool('inspection', 'acme_inspect', {}, { resultPreview: 'ACME-001 inspection-due' }),
        say('report', 'Inspect the filter on ACME-001.'),
      ]
      if (live) await render(nodes, turn(nodes))
      await render(nodes, turn(nodes, { status: 'completed', endedAt: '2026-10-01T00:00:01.000Z' }))
      expect(wrapper('report')?.hidden).toBe(false)
      expect(wrapper('inspection')?.hidden).toBe(false)
      expect(host.textContent).toContain('ACME-001 inspection-due')
      expect(host.querySelector('[data-testid="turn-process-toggle"]')?.getAttribute('aria-expanded')).toBe(
        'true',
      )
    },
  )

  it.each(['zh-CN', 'en'] as const)('keeps usage out of the turn process details (%s)', async (locale) => {
    const calls: UITurn['usage']['calls'] = [1, 2, 3].map((n) => ({
      id: `call:${n}`,
      seq: n + 2,
      purpose: 'inference',
      model: 'test-model',
      creditSource: 'estimated',
      tokens: { input: 777, output: 10, cacheRead: 0, cacheWrite: 0 },
      billing: { usdMicros: 246, source: 'estimated', subscription: false },
    }))
    const nodes: UINode[] = [
      user,
      say('final', 'answer'),
      ...calls.map((call) => ({
        kind: 'cost' as const,
        ...call,
        source: call.creditSource,
      })),
    ]
    const current = turn(nodes, {
      // Late cost nodes can sit outside the turn's loaded node list.
      nodeIds: ['user', 'final'],
      status: 'completed',
      finalAssistantId: 'final',
      durationMs: 12000,
      usage: {
        totals: { input: 2331, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        calls,
        cost: { usdMicros: 738, source: 'estimated', subscription: false },
        reasoningComplete: true,
        billingComplete: true,
      },
    })
    const noUsage = () => {
      expect(host.querySelectorAll('[data-node-kind="cost"], .timeline-unassigned .call-usage')).toHaveLength(
        0,
      )
      // Anywhere in the turn but its footer, whose hover card owns usage.
      const leaked = [
        ...host.querySelectorAll(
          '[data-testid="turn-process-usage-total"], [data-testid="turn-usage-calls"], .turn-usage-panel, .call-usage',
        ),
      ].filter((node) => !node.closest('.turn-footer'))
      expect(leaked).toHaveLength(0)
    }
    for (const live of [true, false]) {
      if (live) await render(nodes, { ...current, status: 'running' }, { t: translate(locale) })
      // Usage alone leaves nothing to unfold: the process row stays hidden.
      await render(nodes, current, { t: translate(locale) })
      expect(host.querySelector<HTMLElement>('.turn-process')?.hidden).toBe(true)
      noUsage()
    }
    // With steps the process still unfolds, and still carries no usage.
    const stepped = [user, tool('ls', 'ls', { path: '.' }), say('final', 'answer')]
    await render(stepped, { ...current, nodeIds: stepped.map((node) => node.id) }, { t: translate(locale) })
    const process = host.querySelector<HTMLElement>('.turn-process')
    expect(process?.hidden).toBe(false)
    expect(host.querySelector('.turn-process-body:not([hidden])')).toBeNull()
    await click(process?.querySelector('[data-testid="turn-process-toggle"]'))
    expect(process?.dataset.open).toBe('true')
    expect(host.querySelector('.turn-process-body:not([hidden])')).not.toBeNull()
    noUsage()
  })

  it('interleaves unboxed prose with one row per run of steps, and opens a run into its steps', async () => {
    const nodes: UINode[] = [
      user,
      say('n1', '我先看看结构。'),
      tool('ls', 'ls', { path: '.' }),
      tool(
        'sh',
        'shell',
        { command: 'cat x' },
        { status: 'failed', resultPreview: 'no such file\n[exit 1]' },
      ),
      tool('rd', 'read', { path: 'a.md' }),
      say('n2', '再确认一下。'),
      tool('gr', 'grep', { pattern: 'x' }),
      say('final', '结论'),
    ]
    await render(nodes, turn(nodes))
    // While the turn runs the process is open: prose is plain, a run of steps is one summary row.
    expect(wrapper('n1')?.className).toBe('turn-process-body turn-narration')
    expect(wrapper('n1')?.hidden).toBe(false)
    expect(groups()).toHaveLength(1)
    const row = groups()[0]?.querySelector<HTMLButtonElement>('[data-testid="turn-activity-toggle"]')
    expect(row?.querySelector('.activity-verb')?.textContent).toBe('已列出目录，运行了命令，已读取文件')
    // The failure is marked on the summary with its reason.
    expect([row?.dataset.state, row?.querySelector('.activity-note')?.textContent]).toEqual([
      'failed',
      '退出码 1',
    ])
    expect(row?.getAttribute('aria-expanded')).toBe('false')
    for (const id of ['ls', 'sh', 'rd']) expect(wrapper(id)?.hidden).toBe(true)
    // A single step needs no summary: its own row shows.
    expect(wrapper('gr')?.hidden).toBe(false)
    expect(wrapper('gr')?.dataset.grouped).toBeUndefined()
    // DOM order is the order things happened.
    expect(
      [...host.querySelectorAll('.turn-node-flow [data-node-id]')].map((node) =>
        node.getAttribute('data-node-id'),
      ),
    ).toEqual(['n1', 'ls', 'sh', 'rd', 'n2', 'gr', 'final'])

    const steps = ['ls', 'sh', 'rd'].map((id) => host.querySelector(`[data-node-id="${id}"]`))
    await click(row)
    expect(row?.getAttribute('aria-expanded')).toBe('true')
    for (const id of ['ls', 'sh', 'rd']) expect(wrapper(id)?.hidden).toBe(false)
    expect(wrapper('sh')?.dataset.grouped).toBe('true')
    const failed = wrapper('sh')?.querySelector<HTMLButtonElement>('[data-testid="tool-detail-toggle"]')
    expect(failed?.textContent).toContain('运行命令')
    expect(failed?.querySelector('.activity-target')).toBeNull()
    expect(failed?.querySelector('.activity-note')?.textContent).toBe('退出码 1')
    await click(failed)
    expect(wrapper('sh')?.querySelector('[data-testid="tool-command"]')?.textContent).toBe('cat x')

    // Settling collapses the process to the answer; nothing was remounted along the way.
    const settled = nodes.map((node) => node)
    await render(
      settled,
      turn(settled, { status: 'completed', finalAssistantId: 'final', durationMs: 12_000 }),
    )
    expect(['ls', 'sh', 'rd'].map((id) => host.querySelector(`[data-node-id="${id}"]`))).toEqual(steps)
    expect(host.querySelector('[data-testid="turn-timing"]')?.textContent).toBe('已完成 · 用时 12 秒')
    expect(wrapper('final')?.className).toBe('turn-final')
    for (const id of ['n1', 'ls', 'gr']) expect(wrapper(id)?.hidden).toBe(true)
    expect(groups()).toHaveLength(0)
    await click(host.querySelector('[data-testid="turn-process-toggle"]'))
    expect(wrapper('n1')?.hidden).toBe(false)
    // The group the reader opened is still open.
    expect(wrapper('sh')?.hidden).toBe(false)
  })

  it('shows the step a working run is on, and counts reasoning as a step of the run', async () => {
    const thinking = say('a', '', { streaming: true, thinking: 'look around\nopen the README first' })
    await render([user, thinking], turn([user, thinking]))
    const thought = host.querySelector<HTMLButtonElement>('[data-testid="thinking-toggle"]')
    expect(thought?.dataset.state).toBe('running')
    expect(thought?.querySelector('.activity-target')?.textContent).toBe('open the README first')
    expect(host.querySelector('[data-testid="turn-timing"]')?.textContent).toMatch(/^正在思考 · \d+ 秒$/)
    expect(host.querySelector('.turn-process')?.getAttribute('data-active')).toBe('true')

    const nodes: UINode[] = [
      user,
      say('a', '', { thinking: 'look around' }),
      tool('rd', 'read', { path: 'README.md' }),
      tool('sh', 'shell', { command: 'pnpm test' }, { status: 'running' }),
    ]
    await render(nodes, turn(nodes))
    const row = groups()[0]?.querySelector<HTMLButtonElement>('[data-testid="turn-activity-toggle"]')
    expect(row?.dataset.state).toBe('running')
    expect(row?.textContent).toBe('运行命令')
    await click(row)
    expect(
      [...host.querySelectorAll('.turn-step:not([hidden]) .activity-verb')].map((verb) => verb.textContent),
    ).toEqual(['思考', '读取', '运行命令'])
  })

  it('records a decided approval as a step and keeps a pending one in view', async () => {
    const approval = (id: string, extra: object): UINode => ({
      kind: 'approval',
      id,
      seq: seq++,
      state: 'decided',
      summary: 'shell ls -la',
      risk: 'always',
      options: ['allow_once'],
      ...extra,
    })
    const nodes: UINode[] = [
      user,
      approval('ok', { decision: { verdict: 'allowed-session', via: 'web' } }),
      approval('no', { decision: { verdict: 'rejected', via: 'web' } }),
      approval('late', { decision: { verdict: 'unavailable', via: 'sync', reason: 'deadline' } }),
      approval('ask', {
        state: 'pending',
        presentation: {
          en: {
            title: 'Human signature',
            fields: [{ label: 'Meaning', value: 'I approve / exact punctuation.' }],
            responseValue: 'I approve / exact punctuation.',
          },
        },
      }),
      say('final', 'done'),
    ]
    await render(nodes, turn(nodes, { status: 'completed', finalAssistantId: 'final' }))
    // Collapsed: only the answer and what still needs the reader are in view.
    expect(wrapper('ok')?.hidden).toBe(true)
    expect([wrapper('ask')?.className, wrapper('ask')?.hidden]).toEqual(['turn-attention', false])
    expect(wrapper('ask')?.querySelector('.activity-row')?.getAttribute('data-state')).toBe('attention')
    expect(wrapper('ask')?.querySelector('.activity-target')?.textContent).toBe('Human signature')
    expect(wrapper('ask')?.querySelector('.activity-target')?.hasAttribute('data-mono')).toBe(false)
    await click(wrapper('ask')?.querySelector('.activity-row'))
    expect(wrapper('ask')?.querySelector('.agh-decision-fields dd')?.textContent).toBe(
      'I approve / exact punctuation.',
    )
    await click(host.querySelector('[data-testid="turn-process-toggle"]'))
    await click(host.querySelector('[data-testid="turn-activity-toggle"]'))
    const verb = (id: string) => wrapper(id)?.querySelector('.activity-verb')?.textContent
    expect([verb('ok'), verb('no'), verb('late')]).toEqual(['已允许本会话执行', '已拒绝', '等待超时，未执行'])
    expect(wrapper('ok')?.querySelector('.activity-target')?.textContent).toBe('运行命令')
    expect(host.querySelector('[data-approval-action]')).toBeNull()
    const waiting: UINode[] = [
      user,
      tool('unrelated', 'read', { path: 'other.md' }, { status: 'running' }),
      tool('waiting', 'shell', { command: 'echo private' }, { status: 'awaiting_approval' }),
      approval('pending', { state: 'pending', summary: 'Run command · Verify report', toolUseId: 'waiting' }),
    ]
    await render(waiting, turn(waiting, { status: 'waiting' }))
    expect(host.querySelector('[data-node-id="waiting"]')).toBeNull()
    expect(host.querySelector('[data-node-id="unrelated"]')).not.toBeNull()
    expect(host.querySelectorAll('[data-testid="approval-step"]')).toHaveLength(1)
    expect(host.querySelector('[data-testid="approval-step"]')?.getAttribute('href')).toBe(
      '#approval-content',
    )
    expect(host.querySelector('[data-testid="approval-step"]')?.textContent).toContain(
      '运行命令 · Verify report',
    )
  })

  it('says nothing above a plain answer and marks only the newest turn as latest', async () => {
    const first = [user, say('a1', 'hi')]
    const second: UINode[] = [
      { kind: 'user', id: 'u2', seq: seq++, content: [{ type: 'text', text: 'again' }] },
      say('a2', 'hello'),
    ]
    const turns = [
      turn(first, { status: 'completed', finalAssistantId: 'a1', durationMs: 2500 }),
      turn(second, { id: 'turn:2', turn: 2, status: 'completed', finalAssistantId: 'a2', durationMs: 900 }),
    ]
    const renderMarkdown = vi.fn((text: string) => text)
    await act(async () =>
      root.render(
        createElement(ConversationMessages, { t, nodes: [...first, ...second], turns, renderMarkdown }),
      ),
    )
    const shells = [...host.querySelectorAll<HTMLElement>('.conversation-turn')]
    expect(shells.map((shell) => shell.dataset.latest)).toEqual([undefined, 'true'])
    for (const shell of shells) {
      expect(shell.querySelector<HTMLElement>('.turn-status')?.hidden).toBe(true)
      expect(shell.querySelector<HTMLElement>('.turn-process')?.hidden).toBe(true)
      expect(shell.querySelector('.turn-done-check')).toBeNull()
    }
    // What the reader wrote can be copied back from under its bubble.
    expect(
      shells[0]?.querySelector('.turn-user [data-testid="user-message-copy"]')?.getAttribute('aria-label'),
    ).toBe('复制消息')
    // Render gate: wire snapshots recreate every object; a token must only invalidate its turn.
    const historicalRenders = () => renderMarkdown.mock.calls.filter(([text]) => text === 'hi').length
    const before = historicalRenders()
    for (let token = 0; token < 20; token++) {
      const next = structuredClone([...first, ...second])
      const answer = next.find((node) => node.id === 'a2')
      if (answer?.kind === 'assistant') answer.text = `hello ${token}`
      await act(async () =>
        root.render(
          createElement(ConversationMessages, {
            t,
            nodes: next,
            turns: structuredClone(turns),
            renderMarkdown,
          }),
        ),
      )
    }
    expect(historicalRenders()).toBe(before)
    expect(host.querySelector('[data-node-id="a2"]')?.textContent).toContain('hello 19')
    // A same-length edit in the middle of history is still a real change.
    const edited = structuredClone([...first, ...second])
    const oldAnswer = edited.find((node) => node.id === 'a1')
    if (oldAnswer?.kind === 'assistant') oldAnswer.text = 'HI'
    await act(async () =>
      root.render(
        createElement(ConversationMessages, {
          t,
          nodes: edited,
          turns: structuredClone(turns),
          renderMarkdown,
        }),
      ),
    )
    expect(host.querySelector('[data-node-id="a1"]')?.textContent).toContain('HI')
    // A caller reusing its array and editing an object must not mutate the retained snapshot.
    if (oldAnswer?.kind === 'assistant') oldAnswer.text = 'BY'
    await act(async () =>
      root.render(
        createElement(ConversationMessages, {
          t,
          nodes: edited,
          turns,
          renderMarkdown,
        }),
      ),
    )
    expect(host.querySelector('[data-node-id="a1"]')?.textContent).toContain('BY')
  })
})

// The package manifests are the shipped inventory, independent of the display catalog.
it.each(['en', 'zh-CN'] as const)('uses one localized title for every declared base tool (%s)', (locale) => {
  const translateTool = translate(locale)
  const directory = resolve('packages/base/extensions')
  const names: string[] = readdirSync(directory).flatMap((folder) => {
    const file = join(directory, folder, 'package.json')
    if (!existsSync(file)) return []
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    return (pkg.agnes?.plugins ?? []).flatMap(
      (row: { capabilities?: { tools?: { names?: string[] } } }) => row.capabilities?.tools?.names ?? [],
    )
  })
  expect(names.length).toBeGreaterThan(50)
  for (const name of names) {
    const title = baseToolTitle(name, translateTool)
    expect(title, name).toBeTruthy()
    expect(title, name).not.toContain('baseTool.')
    if (locale === 'zh-CN') expect(title, name).toMatch(/[\u4e00-\u9fff]/)
    expect(toolStep(tool(name, name, {}), translateTool).verb, name).toBe(title)
    expect(
      approvalSummary(
        {
          kind: 'approval',
          id: name,
          seq: 1,
          state: 'decided',
          risk: 'always',
          options: [],
          summary: 'Run tool · Verify Record-1',
          toolName: name,
        },
        translateTool,
      ),
      name,
    ).toBe(`${title} · Verify Record-1`)
    expect(
      approvalSummary(
        {
          kind: 'approval',
          id: name,
          seq: 1,
          state: 'decided',
          risk: 'always',
          options: [],
          summary: 'Run tool · Verify Record-1',
          subjectText: JSON.stringify({ call: { name } }),
        },
        translateTool,
      ),
      name,
    ).toBe(`${title} · Verify Record-1`)
  }
  expect(
    approvalSummary(
      {
        kind: 'approval',
        id: 'plugin',
        seq: 1,
        state: 'pending',
        risk: 'always',
        options: [],
        summary: 'Read file · custom purpose',
        subjectText: '{"call":{"name":"custom_review"}}',
      },
      translateTool,
    ),
  ).toBe('Read file · custom purpose')
  const reason =
    locale === 'zh-CN'
      ? '本轮包含不可信的工具输出；后续修改需要您确认'
      : 'This turn contains untrusted tool output; changes require approval'
  for (const [name, summary, expected] of [
    ['shell', 'Run command', baseToolTitle('shell', translateTool)],
    ['custom_review', '登记项目 · PRJ-009', '登记项目 · PRJ-009'],
  ] as const)
    expect(
      approvalSummary(
        {
          kind: 'approval',
          id: 'taint',
          seq: 1,
          state: 'pending',
          risk: 'always',
          options: [],
          toolName: name,
          summary: `${summary} — This turn contains untrusted tool output; changes require approval`,
        },
        translateTool,
      ),
    ).toBe(`${expected} — ${reason}`)
})
