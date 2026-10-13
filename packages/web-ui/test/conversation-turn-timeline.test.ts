/** @vitest-environment happy-dom */

import type { UINode, UITurn } from '@agnes/protocol'
import { ConversationMessages, type ConversationMessagesProps } from '@agnes/web-ui/conversation'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  activitySummary,
  shortenHome,
  thoughtLine,
  toolKind,
  toolStep,
} from '../src/conversation/messages/tool-step.js'
import { webSources } from '../src/conversation/messages/web-sources.js'
import { webUiLocaleCatalog } from '../src/locales/index.js'

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
    expect(toolStep(tool('b', 'shell', { command: 'ls -la\necho done' }), t).target).toBe('ls -la')
    expect(
      toolStep(tool('c', 'read', { path: `${['', 'Users', 'someone'].join('/')}/work/a.md` }), t),
    ).toMatchObject({
      kind: 'read',
      verb: '读取',
      target: '~/work/a.md',
    })
    expect(toolStep(tool('d', 'grep', { pattern: 'TODO', path: '.' }), t)).toMatchObject({
      verb: '搜索',
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
      verb: '调用 plugin_hello_tool',
      target: 'hi',
    })
    expect(toolStep(tool('h', 'ask_user_question', {}), t, { name: '提问' })).toMatchObject({
      verb: '提问',
      target: '',
    })
  })

  it('reads the target from an argument preview that was clipped mid-JSON', () => {
    const clipped = `{"command":"pnpm test --run \\"fast\\"","content":"${'x'.repeat(40)}`
    expect(toolStep(tool('a', 'shell', {}, { argsPreview: clipped }), t).target).toBe(
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
    expect(failed?.querySelector('.activity-target')?.textContent).toBe('cat x')
    expect(failed?.querySelector('.activity-note')?.textContent).toBe('退出码 1')
    await click(failed)
    expect(wrapper('sh')?.querySelector('[data-testid="tool-detail-text"]')?.textContent).toBe(
      '$ cat x\n\n执行结果\nno such file',
    )

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
    expect(row?.textContent).toBe('运行命令·pnpm test')
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
      approval('ask', { state: 'pending' }),
      say('final', 'done'),
    ]
    await render(nodes, turn(nodes, { status: 'completed', finalAssistantId: 'final' }))
    // Collapsed: only the answer and what still needs the reader are in view.
    expect(wrapper('ok')?.hidden).toBe(true)
    expect([wrapper('ask')?.className, wrapper('ask')?.hidden]).toEqual(['turn-attention', false])
    expect(wrapper('ask')?.querySelector('.activity-row')?.getAttribute('data-state')).toBe('attention')
    await click(host.querySelector('[data-testid="turn-process-toggle"]'))
    await click(host.querySelector('[data-testid="turn-activity-toggle"]'))
    const verb = (id: string) => wrapper(id)?.querySelector('.activity-verb')?.textContent
    expect([verb('ok'), verb('no'), verb('late')]).toEqual(['已允许本会话执行', '已拒绝', '等待超时，未执行'])
    expect(wrapper('ok')?.querySelector('.activity-target')?.textContent).toBe('shell ls -la')
    expect(host.querySelector('[data-approval-action]')).toBeNull()
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
    await act(async () =>
      root.render(createElement(ConversationMessages, { t, nodes: [...first, ...second], turns })),
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
  })
})
