import { conversationCards as testCards, workbenchPanels as testPanels } from '@agnes/web-client'
/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type { UINode, UITurn } from '@agnes/protocol'
import { LocaleService, SessionService, type SlotEntry, SlotRegistry, ThemeService } from '@agnes/web-client'
import { costDetails, costSummary } from '@agnes/web-conversation/usage'
import { setDisclosureOpen, webUiLocaleCatalog } from '@agnes/web-ui'
import { createConversationProjectionStore, useConversationProjection } from '@agnes/web-ui/conversation'
import { act, createElement, useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answeredQuestions,
  renderedSurfaceIds,
} from '../../web-conversation/src/intelligent-ui/conversation.js'
import { mountIntelligentUi } from '../../web-conversation/src/intelligent-ui/mount.js'
import { WebConversationMessages } from '../src/conversation-message-adapter.js'
import { zhLocaleService, zhT } from './helpers/locale.js'

let host: HTMLDivElement
let root: Root
let ctx: Context
let registry: SlotRegistry
let stopInteraction: (() => void) | undefined

beforeEach(async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ctx = new Context()
  await ctx.plugin(SlotRegistry)
  registry = (ctx as unknown as { slots: SlotRegistry }).slots
  registry.setSession('session')
  registry.declare('conversation.chat.node', { kind: 'keyed', scope: 'session' })
  registry.declare('tool.call.toolview', { kind: 'keyed', scope: 'session' })
})

afterEach(async () => {
  await act(async () => root.unmount())
  stopInteraction?.()
  stopInteraction = undefined
  await ctx.fiber.dispose()
  host.remove()
  vi.unstubAllGlobals()
})

const user: UINode = { kind: 'user', id: 'user', seq: 1, content: [{ type: 'text', text: 'earlier' }] }
const slot = (current: number): UINode => ({
  kind: 'slot',
  id: 'slot',
  fill: { slot: 'tool.card.inline', extId: 'plugin-a', payload: { current } },
})
const tool = (status: Extract<UINode, { kind: 'tool' }>['status']): Extract<UINode, { kind: 'tool' }> => ({
  kind: 'tool',
  id: 'tool',
  seq: 2,
  toolUseId: 'call',
  name: 'read_file',
  status,
  summary: status === 'failed' ? '读取失败' : '读取文件',
  ...(status === 'failed' ? { resultPreview: 'Permission denied' } : {}),
})

function Harness({ store }: { store: ReturnType<typeof createConversationProjectionStore> }) {
  const projection = useConversationProjection(store)
  return createElement(WebConversationMessages, {
    nodes: projection.nodes,
    registry,
    claim: (entry, extId) => entry.owner === extId,
    locale: zhLocaleService(),
  })
}

async function mount(store: ReturnType<typeof createConversationProjectionStore>) {
  await act(async () => root.render(createElement(Harness, { store })))
}
async function update(store: ReturnType<typeof createConversationProjectionStore>, nodes: UINode[]) {
  await act(async () => store.update({ sessionId: 'session', nodes }))
}
const item = (id: string) => host.querySelector<HTMLElement>(`[data-node-id="${id}"]`)

describe('W3b Web-owned leaves and real web-client slots', () => {
  it('retires a reused slot ID when the session changes', async () => {
    const lifecycle: string[] = []
    function Card() {
      const [count, setCount] = useState(0)
      useEffect(() => {
        lifecycle.push('mount')
        return () => {
          lifecycle.push('unmount')
        }
      }, [])
      return createElement('button', { type: 'button', onClick: () => setCount(count + 1) }, String(count))
    }
    const off = registry.register('tool.card.inline', Card as never, {
      owner: 'plugin-a',
      id: 'session-card',
    })
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [slot(1)] })
    await mount(store)
    const original = item('slot')?.querySelector('[data-agnes-region="slot-card"]')
    await act(async () => original?.querySelector('button')?.click())
    expect(original?.querySelector('button')?.textContent).toBe('1')
    await act(async () => {
      registry.setSession('second')
      store.update({ sessionId: 'second', nodes: [slot(2)] })
      await Promise.resolve()
    })
    const next = item('slot')?.querySelector('[data-agnes-region="slot-card"]')
    expect(next).not.toBe(original)
    expect(next?.querySelector('button')?.textContent).toBe('0')
    expect(lifecycle).toEqual(['mount', 'unmount', 'mount'])
    off()
  })

  it('keeps the ID-keyed slot host and plugin state through updates and history prepend, then cleans up', async () => {
    const lifecycle: string[] = []
    function Card({ fill }: { fill: { payload: unknown } }) {
      const [count, setCount] = useState(0)
      useEffect(() => {
        lifecycle.push('mount')
        return () => {
          lifecycle.push('unmount')
        }
      }, [])
      return createElement(
        'button',
        { type: 'button', onClick: () => setCount(count + 1) },
        `${JSON.stringify(fill.payload)} · ${count}`,
      )
    }
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [slot(1)] })
    await mount(store)
    const container = item('slot')?.querySelector<HTMLElement>('[data-agnes-region="slot-card"]')
    expect(container?.textContent).toContain('此卡片的插件未就绪')
    const off = registry.register('tool.card.inline', Card as never, { owner: 'plugin-a', id: 'card' })
    await act(async () => {
      await Promise.resolve()
    })
    const button = container?.querySelector<HTMLButtonElement>('button')
    expect(button?.textContent).toContain('"current":1')
    await act(async () => button?.click())
    expect(button?.textContent).toContain('· 1')
    await update(store, [slot(2)])
    expect(item('slot')?.querySelector('[data-agnes-region="slot-card"]')).toBe(container)
    expect(container?.querySelector('button')).toBe(button)
    expect(button?.textContent).toContain('"current":2')
    await update(store, [user, slot(3)])
    expect(
      Array.from(host.querySelectorAll('[data-node-id]')).map((node) => node.getAttribute('data-node-id')),
    ).toEqual(['user', 'slot'])
    expect(item('slot')?.querySelector('[data-agnes-region="slot-card"]')).toBe(container)
    expect(container?.querySelector('button')).toBe(button)
    expect(button?.textContent).toContain('· 1')
    await act(async () => {
      off()
      await Promise.resolve()
    })
    expect(container?.textContent).toContain('此卡片的插件未就绪')
    expect(lifecycle).toEqual(['mount', 'unmount'])
    await update(store, [user])
    expect(item('slot')).toBeNull()
    expect(container?.isConnected).toBe(false)
    const offAgain = registry.register('tool.card.inline', Card as never, {
      owner: 'plugin-a',
      id: 'card-again',
    })
    await update(store, [user, slot(4)])
    expect(lifecycle).toEqual(['mount', 'unmount', 'mount'])
    await act(async () => root.render(null))
    expect(lifecycle).toEqual(['mount', 'unmount', 'mount', 'unmount'])
    offAgain()
  })

  it('uses the shared tool card, shared React cost detail and Markdown leaves, with DSH toolview claim and fallback', async () => {
    const assistant: UINode = {
      kind: 'assistant',
      id: 'assistant',
      seq: 1,
      text: '**first**',
      thinking: 'thought',
      streaming: true,
    }
    const cost: UINode = { kind: 'cost', id: 'cost', seq: 3, source: 'estimated' }
    const store = createConversationProjectionStore({
      sessionId: 'session',
      nodes: [assistant, tool('running'), cost],
    })
    await mount(store)
    const markdownHost = item('assistant')?.querySelector('.node-body [data-agnes-markdown-leaf]')
    const paragraph = item('assistant')?.querySelector('.node-body p')
    expect(paragraph?.textContent).toBe('first')
    const toolElement = item('tool')?.querySelector<HTMLElement>('[data-agnes-tool-card]')
    expect(toolElement?.querySelector('.activity-row')?.getAttribute('data-state')).toBe('running')
    expect(item('tool')?.getAttribute('aria-label')).toContain('正在执行')
    expect(toolElement?.querySelector('svg.icon.tool-icon')?.getAttribute('aria-hidden')).toBe('true')
    const details = item('cost')?.querySelector<HTMLElement>('.agh-disclosure.call-usage')
    expect(details?.textContent).toContain('费用未提供')
    if (details) setDisclosureOpen(details, true)
    const off = registry.register(
      { name: 'tool.call.toolview', key: 'read_file', id: 'toolview' },
      ({ owner }: { owner?: { block: { status: string } } }) =>
        createElement('div', { id: 'custom-toolview' }, owner?.block.status),
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(item('tool')?.querySelector('#custom-toolview')?.textContent).toBe('running')
    expect(item('tool')?.querySelector<HTMLElement>('[data-agnes-timeline-native]')?.hidden).toBe(true)
    await update(store, [
      { ...assistant, text: '**first** second', streaming: false },
      tool('failed'),
      { ...cost, source: 'gateway', credits: 1.25 },
    ])
    expect(item('assistant')?.querySelector('.node-body [data-agnes-markdown-leaf]')).toBe(markdownHost)
    expect(item('assistant')?.textContent).toContain('second')
    expect(item('tool')?.querySelector('#custom-toolview')?.textContent).toBe('failed')
    expect(details?.dataset.open).toBe('true')
    expect(details?.textContent).toContain('1.25 credits（网关记录）')
    await act(async () => {
      off()
      await Promise.resolve()
    })
    expect(item('tool')?.querySelector('#custom-toolview')).toBeNull()
    expect(item('tool')?.querySelector<HTMLElement>('[data-agnes-timeline-native]')?.hidden).toBe(false)
    expect(item('tool')?.textContent).toContain('Permission denied')
    expect(item('tool')?.querySelector('[data-agnes-tool-card]')).toBe(toolElement)
    await update(store, [user, assistant, tool('failed'), cost])
    expect(item('tool')?.querySelector('[data-agnes-tool-card]')).toBe(toolElement)
    await act(async () => {
      registry.setSession('second')
      store.update({ sessionId: 'second', nodes: [tool('planned')] })
      await Promise.resolve()
    })
    expect(item('tool')?.querySelector('[data-agnes-tool-card]')).not.toBe(toolElement)
    expect(item('tool')?.getAttribute('aria-label')).toContain('等待执行')
    expect(item('tool')?.querySelector('.activity-row')?.getAttribute('data-state')).toBeNull()
  })

  it('updates a tool glyph and retains its disclosure when a tool name changes under the same ID', async () => {
    const initial = tool('running')
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [initial] })
    await mount(store)
    const card = item('tool')?.querySelector<HTMLElement>('[data-agnes-tool-card]')
    const button = card?.querySelector<HTMLButtonElement>('.tool-detail')
    expect(card?.querySelector('.tool-detail-body')?.getAttribute('aria-hidden')).toBe('true')
    await act(async () => button?.click())
    expect(card?.querySelector('.tool-detail-body')?.getAttribute('aria-hidden')).toBe('false')
    button?.focus()
    await update(store, [{ ...initial, name: 'web_search', status: 'completed' }])
    expect(item('tool')?.querySelector('[data-agnes-tool-card]')).toBe(card)
    expect(card?.querySelector('svg.icon.tool-icon path')?.getAttribute('d')).toContain('m21 21-4.34-4.34')
    expect(button?.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(button)
  })

  it('retains selected tool detail text until the reader releases the selection', async () => {
    const initial = { ...tool('running'), argsPreview: 'first argument' }
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [initial] })
    await mount(store)
    await act(async () => item('tool')?.querySelector<HTMLButtonElement>('.tool-detail')?.click())
    const detail = item('tool')?.querySelector<HTMLElement>('[data-testid=tool-raw-args]')
    if (!detail?.firstChild) throw new Error('missing tool detail text')
    const selection = document.getSelection()
    const range = document.createRange()
    range.selectNodeContents(detail.firstChild)
    selection?.removeAllRanges()
    selection?.addRange(range)
    try {
      await update(store, [{ ...initial, argsPreview: 'first argument plus more' }])
      expect(selection?.toString()).toContain('first argument')
      expect(detail.textContent).not.toContain('plus more')
      await act(async () => {
        selection?.removeAllRanges()
        document.dispatchEvent(new Event('selectionchange'))
        await Promise.resolve()
      })
      expect(detail.textContent).toContain('first argument plus more')
    } finally {
      selection?.removeAllRanges()
    }
  })
})

it('uses the complete shared cost contract through the real adapter without an imperative cost leaf', async () => {
  const cost: Extract<UINode, { kind: 'cost' }> = {
    kind: 'cost',
    id: 'cost',
    seq: 2,
    source: 'estimated',
    purpose: 'compaction',
    tokens: { input: 1200, output: 10, cacheRead: 3, cacheWrite: 0, reasoning: 0 },
    billing: { usdMicros: 200, source: 'estimated', subscription: false },
    credits: 0.5,
    timing: { ttftMs: 0, durationMs: 1000 },
    model: 'model',
  }
  const store = createConversationProjectionStore({ sessionId: 'session', nodes: [cost] })
  await mount(store)
  const article = item('cost')
  const details = article?.querySelector<HTMLElement>('.agh-disclosure')
  const summary = article?.querySelector<HTMLElement>('.agh-disclosure-summary')
  if (!details || !summary) throw new Error('missing cost disclosure')
  setDisclosureOpen(details, true)
  summary.focus()
  const gateway = {
    ...cost,
    source: 'gateway' as const,
    model: '<img src=x> **literal**',
    interrupted: true,
    billing: { usdMicros: 0, source: 'gateway' as const, subscription: true },
    credits: 0,
  }
  for (const next of [gateway, { ...gateway }]) {
    await update(store, [user, next])
    expect(item('cost')).toBe(article)
    expect(article?.querySelector<HTMLElement>('.agh-disclosure')).toBe(details)
    expect(article?.querySelector<HTMLElement>('.agh-disclosure-summary')).toBe(summary)
    expect(details.dataset.open).toBe('true')
    expect(document.activeElement).toBe(summary)
    expect(summary.textContent).toBe(costSummary(next, zhT))
    const rows = Array.from(article?.querySelectorAll('dt') ?? []).map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ])
    expect(rows).toEqual(costDetails(next, zhT))
    expect(article?.querySelector('img, strong, [data-agnes-cost-details]')).toBeNull()
    expect(
      Array.from(host.querySelectorAll('[data-node-id]')).map((el) => el.getAttribute('data-node-id')),
    ).toEqual(['user', 'cost'])
  }
  await update(store, [user])
  expect(details.isConnected).toBe(false)
})

it.each([true, false])('shows a failed turn reason through the React adapter (%s)', async (withError) => {
  vi.stubGlobal('fetch', async () =>
    Response.json({
      items: [],
      growth: [],
      counts: { up: 0, down: 0, withdrawn: 0, withCandidate: 0 },
      truncated: false,
    }),
  )
  const session = new SessionService(ctx, 'session')
  const message = 'Increase the context budget. <img src=x> **literal**'
  const turn: UITurn = {
    id: 'turn:1',
    turn: 1,
    startSeq: 1,
    endSeq: 3,
    startedAt: '2026-10-01T00:00:00.000Z',
    endedAt: '2026-10-01T00:00:01.000Z',
    status: 'failed',
    reason: 'budget',
    nodeIds: ['user', 'assistant'],
    inherited: false,
    forkable: false,
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: false,
      billingComplete: false,
      calls: [],
    },
    ...(withError ? { error: { code: 'BUDGET_EXCEEDED', message } } : {}),
  }
  const nodes: UINode[] = [user, { kind: 'assistant', id: 'assistant', seq: 2, text: 'earlier progress' }]
  const store = createConversationProjectionStore({ sessionId: 'session', nodes, turns: [turn] })
  function FailedTurn({ current }: { current: UITurn }) {
    const projection = useConversationProjection(store)
    return createElement(WebConversationMessages, {
      nodes: projection.nodes,
      registry,
      session,
      turns: [current],
      locale: zhLocaleService(),
    })
  }
  await act(async () => root.render(createElement(FailedTurn, { current: turn })))
  const error = host.querySelector<HTMLElement>('.turn-error')
  expect(error?.getAttribute('role')).toBe('alert')
  expect(error?.textContent).toBe('这次执行达到了费用上限。')
  expect(error?.closest('.turn-process, .turn-process-body')).toBeNull()
  expect(error?.querySelector('img, strong')).toBeNull()
  expect(host.querySelector<HTMLElement>('.turn-process')?.dataset.open).toBe('false')
  await act(async () =>
    root.render(
      createElement(FailedTurn, {
        current: { ...turn, status: 'completed', reason: 'completed', finalAssistantId: 'assistant' },
      }),
    ),
  )
  expect(host.querySelector('.turn-error')).toBeNull()
  // Rating the answer is part of the turn's one action bar.
  expect(host.querySelectorAll('[data-testid="message-feedback"]')).toHaveLength(1)
  expect(host.querySelector('.turn-footer [data-testid="message-feedback"]')).not.toBeNull()
  for (const current of [
    { ...turn, status: 'running' as const, finalAssistantId: 'assistant' },
    { ...turn, status: 'completed' as const, finalAssistantId: 'assistant', inherited: true },
  ]) {
    await act(async () => root.render(createElement(FailedTurn, { current })))
    expect(host.querySelector('[data-testid="message-feedback"]')).toBeNull()
  }
})

it('shows the retry only once the session is live and wires it to the host', async () => {
  const session = new SessionService(ctx, 'session')
  const onRetry = vi.fn()
  const failedTurn: UITurn = {
    id: 'turn:1',
    turn: 1,
    startSeq: 1,
    endSeq: 3,
    startedAt: '2026-10-01T00:00:00.000Z',
    endedAt: '2026-10-01T00:00:01.000Z',
    status: 'failed',
    reason: 'error',
    error: { code: 'TRANSPORT', message: 'status=500' },
    nodeIds: ['user', 'assistant'],
    inherited: false,
    forkable: false,
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: false,
      billingComplete: false,
      calls: [],
    },
  }
  const nodes: UINode[] = [user, { kind: 'assistant', id: 'assistant', seq: 2, text: 'earlier progress' }]
  const store = createConversationProjectionStore({ sessionId: 'session', nodes, turns: [failedTurn] })
  function FailedTurn() {
    const projection = useConversationProjection(store)
    return createElement(WebConversationMessages, {
      nodes: projection.nodes,
      registry,
      session,
      ...(projection.turns ? { turns: projection.turns } : {}),
      locale: zhLocaleService(),
      turnErrorActions: { onRetry },
    })
  }
  await act(async () => root.render(createElement(FailedTurn)))
  expect(host.querySelector('.turn-error')?.textContent).toBe('连接模型服务失败。状态 500')
  const findRetry = () => [...host.querySelectorAll('button')].find((button) => button.textContent === '重试')
  // A session that is still connecting cannot carry the retry.
  expect(findRetry()).toBeUndefined()
  await act(async () => session.setReadiness('ready', 'session'))
  const retry = findRetry()
  expect(retry).toBeDefined()
  await act(async () => retry?.click())
  expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 'turn:1' }))
})

it('keeps each React action footer through replay and history prepend, then retires reused turn IDs across sessions', async () => {
  const firstNodes: UINode[] = [
    { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'first' }] },
    { kind: 'assistant', id: 'a1', seq: 2, text: 'first answer' },
    { kind: 'user', id: 'u2', seq: 3, content: [{ type: 'text', text: 'second' }] },
    { kind: 'assistant', id: 'a2', seq: 4, text: 'second answer' },
  ]
  const makeTurn = (id: string, userId: string, answerId: string): UITurn => ({
    id,
    turn: Number(id.slice(-1)),
    startSeq: 1,
    startedAt: '2026-09-27T00:00:00.000Z',
    endedAt: '2026-09-27T00:00:01.000Z',
    status: 'completed',
    nodeIds: [userId, answerId],
    finalAssistantId: answerId,
    inherited: false,
    forkable: true,
    usage: {
      totals: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    },
  })
  const first = makeTurn('turn:1', 'u1', 'a1')
  const second = makeTurn('turn:2', 'u2', 'a2')
  const earlier = makeTurn('turn:0', 'u0', 'a0')
  const store = createConversationProjectionStore({
    sessionId: 'session',
    nodes: firstNodes,
    turns: [first, second],
  })
  const onFork = async () => {
    throw new Error('offline')
  }
  function TurnHarness({ turns }: { turns: UITurn[] }) {
    const projection = useConversationProjection(store)
    return createElement(WebConversationMessages, {
      nodes: projection.nodes,
      registry,
      turns,
      onFork,
      locale: zhLocaleService(),
    })
  }
  await act(async () => root.render(createElement(TurnHarness, { turns: [first, second] })))
  const firstFooter = host.querySelector<HTMLElement>('[data-turn-id="turn:1"] footer.turn-footer')
  const secondFooter = host.querySelector<HTMLElement>('[data-turn-id="turn:2"] footer.turn-footer')
  const secondDetails = secondFooter?.querySelector<HTMLElement>('.turn-usage')
  const secondSummary = secondDetails?.querySelector<HTMLElement>('.agh-disclosure-summary')
  expect(secondFooter).not.toBeNull()
  expect(secondDetails).not.toBeNull()
  if (!secondDetails || !secondSummary) throw new Error('missing second turn disclosure')
  setDisclosureOpen(secondDetails, true)
  secondSummary.focus()

  const prepended: UINode[] = [
    { kind: 'user', id: 'u0', seq: -1, content: [{ type: 'text', text: 'earlier' }] },
    { kind: 'assistant', id: 'a0', seq: 0, text: 'earlier answer' },
    ...firstNodes,
  ]
  await act(async () => {
    store.update({ sessionId: 'session', nodes: prepended, turns: [earlier, first, second] })
    root.render(createElement(TurnHarness, { turns: [earlier, first, second] }))
  })
  expect(
    Array.from(host.querySelectorAll('[data-turn-id]')).map((item) => item.getAttribute('data-turn-id')),
  ).toEqual(['turn:0', 'turn:1', 'turn:2'])
  expect(host.querySelector('[data-turn-id="turn:2"] footer.turn-footer')).toBe(secondFooter)
  expect(secondDetails.dataset.open).toBe('true')
  expect(document.activeElement).toBe(secondSummary)
  await act(async () => {
    store.update({ sessionId: 'session', nodes: prepended, turns: [earlier, first, second] })
  })
  expect(host.querySelector('[data-turn-id="turn:2"] footer.turn-footer')).toBe(secondFooter)

  const fork = host.querySelector<HTMLButtonElement>('[data-turn-id="turn:1"] [aria-label="分支到新聊天"]')
  await act(async () => fork?.click())
  expect(host.querySelector('[data-turn-id="turn:1"] .turn-feedback')?.textContent).toBe('分支失败，请重试。')
  expect(host.querySelector('[data-turn-id="turn:2"] .turn-feedback')?.textContent).toBe('')
  await act(async () => {
    registry.setSession('next-session')
    store.update({ sessionId: 'next-session', nodes: firstNodes.slice(0, 2), turns: [first] })
    root.render(createElement(TurnHarness, { turns: [first] }))
  })
  expect(host.querySelector('[data-turn-id="turn:1"] .turn-feedback')?.textContent).toBe('')
  expect(host.querySelector('[data-turn-id="turn:2"]')).toBeNull()
  expect(host.querySelector('[data-turn-id="turn:1"] footer.turn-footer')).not.toBe(firstFooter)
})

it('keeps installed cards, jobs and children visible when settled process history collapses', async () => {
  const cardNodes: UINode[] = [
    user,
    tool('completed'),
    {
      ...tool('completed'),
      id: 'question',
      name: 'ask_user_question',
      slots: [
        {
          slot: 'tool.card.inline',
          extId: 'interaction',
          payload: {
            title: 'Question',
          },
        },
      ],
    },
    {
      ...tool('completed'),
      id: 'files',
      name: 'present',
      slots: [
        {
          slot: 'tool.card.inline',
          extId: 'present',
          payload: {
            title: 'Files',
          },
        },
      ],
    },
    { ...tool('completed'), id: 'jobs', name: 'job_output', resultPreview: 'job-a: running' },
    { ...tool('completed'), id: 'children', name: 'subagent_list', resultPreview: 'child-a completed' },
    {
      kind: 'approval',
      id: 'approval',
      seq: 3,
      state: 'pending',
      summary: 'Approve plan',
      risk: 'always',
      options: ['allow_once', 'reject_once'],
    },
    { kind: 'assistant', id: 'final', seq: 4, text: 'Review the report' },
  ]
  const turn: UITurn = {
    id: 'turn:cards',
    turn: 1,
    startSeq: 1,
    startedAt: '2026-10-01T00:00:00Z',
    endedAt: '2026-10-01T00:00:01Z',
    status: 'completed',
    nodeIds: cardNodes.map((node) => node.id),
    finalAssistantId: 'final',
    inherited: false,
    forkable: false,
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    },
  }
  const store = createConversationProjectionStore({ sessionId: 'session', nodes: cardNodes, turns: [turn] })
  function CardsHarness() {
    const projection = useConversationProjection(store)
    return createElement(WebConversationMessages, {
      nodes: projection.nodes,
      registry,
      turns: [turn],
      locale: zhLocaleService(),
    })
  }
  await act(async () => root.render(createElement(CardsHarness)))
  expect(host.querySelector<HTMLElement>('.turn-process')?.dataset.open).toBe('false')
  expect(item('tool')?.parentElement?.hidden).toBe(true)
  for (const id of ['question', 'files', 'jobs', 'children', 'approval']) {
    expect(item(id)?.parentElement?.className).toBe('turn-attention')
    expect(item(id)?.parentElement?.hidden).toBe(false)
  }
  for (const id of ['background-job-card', 'child-agent-card'])
    expect(host.querySelector(`[data-testid="${id}"]`)).not.toBeNull()
  expect(host.querySelector('[data-testid="child-engine-output"]')?.textContent).toContain(
    'child-a completed',
  )
  expect(host.querySelector('[data-testid="child-engine-output"]')?.getAttribute('aria-label')).toBe(
    '子代理引擎输出',
  )
  await act(async () => host.querySelector<HTMLElement>('[data-testid="turn-process-toggle"]')?.click())
  expect(item('question')?.parentElement?.hidden).toBe(false)
})

it('summarizes interaction protocol and exact demo echoes while preserving raw details and arbitrary prose', async () => {
  const protocol = 'Question remains open.\nSubmit through the authenticated surface.'
  const question: Extract<UINode, { kind: 'tool' }> = {
    ...tool('completed'),
    name: 'ask_user_question',
    summary: protocol,
    resultPreview: protocol,
  }
  const echo: UINode = {
    kind: 'assistant',
    id: 'echo',
    seq: 3,
    text: `[Demo model — local, deterministic, no API key] Tool result: ${protocol.replace('\n', ' ')}`,
  }
  const prose: UINode = { kind: 'assistant', id: 'prose', seq: 4, text: `My own explanation: ${protocol}` }
  const store = createConversationProjectionStore({ sessionId: 'session', nodes: [question, echo, prose] })
  await mount(store)
  expect(item('tool')?.querySelector('.tool-name')?.textContent).toBe('提问')
  expect(item('tool')?.querySelector('.activity-target')?.textContent).toBe('向你提了问题')
  expect(item('echo')?.querySelector('[data-testid=interaction-result-details]')).toBeNull()
  expect(item('tool')?.querySelectorAll('[data-testid=tool-detail-toggle]')).toHaveLength(1)
  expect(item('tool')?.querySelector('[data-testid=tool-detail-text]')?.textContent).toContain(
    protocol.replace('\n', ' '),
  )
  expect(item('prose')?.querySelector('[data-testid=interaction-result-summary]')).toBeNull()
  expect(item('prose')?.textContent).toContain(`My own explanation: ${protocol}`)
  const business: UINode = {
    ...tool('completed'),
    id: 'business',
    name: 'community_review',
    resultPreview: '{"revision":2,"object":"NCR-018"}',
  }
  const businessEcho: UINode = {
    kind: 'assistant',
    id: 'business-echo',
    seq: 5,
    text: '[Demo model — local, deterministic, no API key] Tool result: {"revision":2,"object":"NCR-018"}',
  }
  await update(store, [question, echo, prose, business, businessEcho])
  expect(item('business-echo')?.querySelector('.markdown')?.textContent ?? '').not.toContain('revision')
  expect(item('business')?.querySelector('[data-testid=tool-detail-text]')?.textContent).toContain(
    '"revision":2',
  )
  const answer: UINode = { kind: 'user', id: 'answer', seq: 5, content: [{ type: 'text', text: 'Two' }] }
  await update(store, [question, echo, prose, answer])
  expect(item('answer')?.querySelector('[data-testid=interaction-result-summary]')).toBeNull()
  const receipt: UINode = {
    kind: 'user',
    id: 'receipt',
    seq: 6,
    origin: 'system',
    content: [{ type: 'text', text: 'unused display text' }],
    system: {
      source: 'agnes/intelligent-ui',
      type: 'action-result',
      summary: 'Submitted',
      data: { commandId: 'machine-only', submitted: { answers: { choice: 'Two' } } },
      presentation: {
        kind: 'ui-action',
        operation: 'submit',
        status: 'succeeded',
        label: 'Submit',
        fields: ['choice'],
      },
    },
  }
  await update(store, [question, echo, prose, answer, receipt])
  expect(item('receipt')?.getAttribute('data-node-kind')).toBe('system-input')
  expect(item('receipt')?.querySelector('[role=status]')?.textContent).toBe('已提交：choice')
  expect(item('receipt')?.querySelector('[data-agnes-assistant-ui-target]')).toBeNull()
  const trace = item('receipt')?.querySelector<HTMLElement>('.agh-disclosure')
  expect(trace?.dataset.open).toBe('false')
  expect(trace?.querySelector('pre')?.textContent).toContain('machine-only')
  if (trace) setDisclosureOpen(trace, true)
  expect(trace?.dataset.open).toBe('true')
  const present: UINode = {
    ...tool('completed'),
    id: 'present',
    name: 'present',
    resultPreview: 'Presented report.md',
  }
  const artifactEcho: UINode = {
    kind: 'assistant',
    id: 'artifact-echo',
    seq: 6,
    text: '[Demo model — local, deterministic, no API key] Tool result: Presented report.md[resource artifact/abc]',
  }
  await update(store, [question, echo, prose, answer, present, artifactEcho])
  expect(item('artifact-echo')?.querySelector('[data-testid=interaction-result-details]')).toBeNull()
  expect(item('present')?.querySelectorAll('[data-testid=tool-detail-toggle]')).toHaveLength(1)
  expect(item('present')?.querySelector('[data-testid=tool-detail-text]')?.textContent).toContain(
    'artifact/abc',
  )
})

it('shows a submitted question as «你的回答» and folds the queued line that announced it', async () => {
  stopInteraction = mountIntelligentUi({
    contributions: { conversationCards: testCards, workbenchPanels: testPanels },
    registry,
    client: { sessions: { get: () => undefined } } as never,
    session: new SessionService(ctx),
    locale: new LocaleService(ctx, 'zh-CN'),
    approval() {},
  })
  const queued: UINode = {
    kind: 'user',
    id: 'queued',
    seq: 7,
    origin: 'system',
    content: [{ type: 'text', text: 'queued' }],
    system: {
      source: 'agnes/deferred-invocations',
      type: 'invocation-queued',
      summary: 'queued',
      data: { invocationId: 'ui:abc' },
    },
  }
  const answers: UINode = {
    kind: 'user',
    id: 'answers',
    seq: 8,
    origin: 'system',
    content: [{ type: 'text', text: 'UI submit succeeded: Submit' }],
    system: {
      source: 'agnes/intelligent-ui',
      type: 'action-result',
      summary: 'UI submit succeeded: Submit',
      data: { status: 'succeeded', submitted: { surfaceId: 'card-q', answers: { days: '3 天 2 晚' } } },
      presentation: {
        kind: 'ui-action',
        operation: 'submit',
        status: 'succeeded',
        label: 'Submit',
        fields: ['days'],
      },
    },
  }
  const submit: UINode = { ...tool('completed'), id: 'submit', name: 'ui_submit' }
  const store = createConversationProjectionStore({
    sessionId: 'session',
    nodes: [user, queued, submit, answers],
  })
  await mount(store)
  expect(item('queued')).toBeNull()
  // The person's submission is not the agent's tool call; only the trace keeps it.
  expect(item('submit')).toBeNull()
  // Without the question surface there is no label, and the id is never shown in its place.
  expect(item('answers')?.querySelector('[data-testid="question-answer-days"]')?.textContent).toBe(
    '3 天 2 晚',
  )
})

it('names the views a turn rendered from its persisted ui_render results', () => {
  const rendered: UINode = {
    ...tool('completed'),
    id: 'render',
    name: 'ui_render',
    resultPreview: '行程框架 — 1 components. [Open review](/?session=s&surface=outline-v1).',
  }
  const other: UINode = { ...tool('completed'), id: 'other', name: 'ui_render', resultPreview: 'failed' }
  const elsewhere: UINode = { ...rendered, id: 'elsewhere' }
  const turn = { id: 't', nodeIds: ['render', 'other'] } as unknown as UITurn
  expect(renderedSurfaceIds([rendered, other, elsewhere], turn)).toEqual(['outline-v1'])
})

it('marks the asking answer «answered» before copy and drops the answer node and ui_submit row', async () => {
  stopInteraction = mountIntelligentUi({
    contributions: { conversationCards: testCards, workbenchPanels: testPanels },
    registry,
    client: { sessions: { get: () => undefined } } as never,
    session: new SessionService(ctx),
    locale: new LocaleService(ctx, 'zh-CN'),
    approval() {},
  })
  const usage = {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: true,
    billingComplete: true,
    calls: [],
  }
  const base = {
    inherited: false,
    forkable: false,
    usage,
    status: 'completed' as const,
    reason: 'completed' as const,
    startedAt: '2026-10-14T08:15:00.000Z',
  }
  const ask: UINode = { ...tool('completed'), id: 'ask', name: 'ask_user_question', resultPreview: 'shown' }
  const render: UINode = {
    ...tool('completed'),
    id: 'render',
    name: 'ui_render',
    resultPreview: 'Questions — 1 components. [Open review](/?session=s&surface=card-q).',
  }
  const reply: UINode = { kind: 'assistant', id: 'reply', seq: 4, text: '动手前先确认 2 件事。' }
  const answer: UINode = {
    kind: 'user',
    id: 'answer',
    seq: 5,
    origin: 'system',
    content: [{ type: 'text', text: 'UI submit succeeded: Submit' }],
    system: {
      source: 'agnes/intelligent-ui',
      type: 'action-result',
      summary: 'UI submit succeeded: Submit',
      data: {
        status: 'succeeded',
        submitted: { surfaceId: 'card-q', answers: { purpose: '公司官网', style: ['简洁', '浅色'] } },
      },
      presentation: {
        kind: 'ui-action',
        operation: 'submit',
        status: 'succeeded',
        label: 'Submit',
        fields: [],
      },
    },
  }
  const submit: UINode = { ...tool('completed'), id: 'submit', seq: 6, name: 'ui_submit' }
  const next: UINode = { kind: 'assistant', id: 'next', seq: 7, text: '收到。' }
  const nodes = [user, ask, render, reply, answer, submit, next]
  const turns: UITurn[] = [
    {
      ...base,
      id: 'turn:1',
      turn: 1,
      startSeq: 1,
      endSeq: 4,
      endedAt: '2026-10-14T08:16:00.000Z',
      nodeIds: ['user', 'ask', 'render', 'reply'],
      finalAssistantId: 'reply',
    },
    {
      ...base,
      id: 'turn:2',
      turn: 2,
      startSeq: 5,
      endSeq: 7,
      nodeIds: ['answer', 'submit', 'next'],
      finalAssistantId: 'next',
    },
  ]
  expect([...answeredQuestions(nodes, turns).keys()]).toEqual(['turn:1'])
  const store = createConversationProjectionStore({ sessionId: 'session', nodes, turns })
  function Asked() {
    const projection = useConversationProjection(store)
    return createElement(WebConversationMessages, {
      nodes: projection.nodes,
      registry,
      turns,
      locale: zhLocaleService(),
    })
  }
  await act(async () => root.render(createElement(Asked)))
  const footer = host.querySelector('[data-turn-id="turn:1"] .turn-footer')
  const badge = footer?.querySelector('[data-testid="question-answered"]')
  // Copy follows the UI locale (the badge's own catalog is checked in web-ui).
  expect(badge?.querySelector('[data-testid="question-answered-badge"]')?.textContent).toMatch(
    /^(Answered 2|已回答 2 项)$/,
  )
  // First in the bar: before copy.
  expect(footer?.firstElementChild).toBe(badge)
  expect(host.querySelector('[data-turn-id="turn:2"] [data-testid="question-answered"]')).toBeNull()
  expect(item('answer')).toBeNull()
  expect(item('submit')).toBeNull()
  expect(host.textContent).not.toMatch(/purpose|style/)
  // Multiple answers read as one phrase.
  expect(badge?.querySelector('[data-testid="question-answer-style"] dd')?.textContent).toMatch(
    /^简洁(、|, )浅色$/,
  )
  await act(async () => {
    stopInteraction?.()
    stopInteraction = undefined
  })
  expect(host.querySelector('[data-testid="question-answered"]')).toBeNull()
  expect(item('answer')).not.toBeNull()
  expect(item('submit')).not.toBeNull()
})

it('keeps completed workflow stage text and tool receipts readable without a final answer', async () => {
  const nodes: UINode[] = [
    user,
    { ...tool('completed'), name: 'acme_inspect', resultPreview: 'ACME-001 inspection-due' },
    {
      kind: 'assistant',
      id: 'stage',
      seq: 3,
      text: 'inspection:\n{"asset":"ACME-001","recommendation":"Inspect filter"}',
    },
  ]
  const turn: UITurn = {
    id: 'workflow-turn',
    turn: 1,
    startSeq: 1,
    startedAt: '2026-10-01T00:00:00Z',
    status: 'completed',
    endedAt: '2026-10-01T00:00:01Z',
    nodeIds: nodes.map((node) => node.id),
    inherited: false,
    forkable: true,
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    },
  }
  await act(async () =>
    root.render(
      createElement(WebConversationMessages, { nodes, turns: [turn], registry, locale: zhLocaleService() }),
    ),
  )
  expect(host.querySelector('[data-testid="turn-process-toggle"]')?.getAttribute('aria-expanded')).toBe(
    'true',
  )
  await act(async () => host.querySelector<HTMLElement>('[data-testid="turn-activity-toggle"]')?.click())
  const stage = host.querySelector<HTMLElement>('[data-node-kind="process-step"]')
  expect(stage?.closest<HTMLElement>('.turn-step')?.hidden).toBe(false)
  expect(stage?.textContent).toContain('ACME-001')
  const receipt = host.querySelector<HTMLElement>('[data-node-kind="tool"]')
  expect(receipt?.closest<HTMLElement>('.turn-step')?.hidden).toBe(false)
  await act(async () => receipt?.querySelector<HTMLElement>('[data-testid="tool-detail-toggle"]')?.click())
  expect(receipt?.querySelector('[data-testid="tool-detail-text"]')?.textContent).toContain(
    'ACME-001 inspection-due',
  )
  expect(receipt?.querySelector('.tool-detail-body')?.getAttribute('aria-hidden')).toBe('false')
})

it('updates memoized history for streaming, decisions, locale catalogs and theme subscribers', async () => {
  const locale = new LocaleService(ctx, 'en')
  locale.register('web-ui', webUiLocaleCatalog)
  const theme = new ThemeService(ctx, 'light')
  function ThemeCard() {
    const value = useSyncExternalStore(theme.subscribe, theme.getSnapshot)
    return createElement('button', { type: 'button', 'data-testid': 'theme-card' }, value)
  }
  const off = registry.register('tool.card.inline', ThemeCard, { owner: 'plugin-a', id: 'theme' })
  const approval: UINode = {
    kind: 'approval',
    id: 'decision',
    seq: 4,
    toolUseId: 'another-call',
    summary: 'Read report',
    state: 'pending',
    risk: 'unknown',
    options: ['allow_once', 'reject_once'],
  }
  let nodes: UINode[] = [
    user,
    tool('running'),
    { kind: 'assistant', id: 'answer', seq: 3, text: 'First', streaming: true },
    approval,
    slot(1),
  ]
  const turns: UITurn[] = [
    {
      id: 'turn',
      turn: 1,
      startSeq: 1,
      startedAt: '2026-10-01T00:00:00Z',
      status: 'running',
      nodeIds: nodes.map((node) => node.id),
      finalAssistantId: 'answer',
      inherited: false,
      forkable: false,
      usage: {
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        reasoningComplete: true,
        billingComplete: true,
        calls: [],
      },
    },
  ]
  const claim = (entry: SlotEntry, extId: string) => entry.owner === extId
  const render = () =>
    act(async () =>
      root.render(
        createElement(WebConversationMessages, {
          nodes: structuredClone(nodes),
          turns: structuredClone(turns),
          registry,
          locale,
          claim,
        }),
      ),
    )
  await render()
  const answer = item('answer')
  const decision = item('decision')
  const toolArticle = item('tool')
  const themeButton = host.querySelector<HTMLButtonElement>('[data-testid="theme-card"]')
  themeButton?.focus()
  nodes = nodes.map((node) =>
    node.id === 'answer' && node.kind === 'assistant'
      ? { ...node, text: 'First appended', streaming: true }
      : node,
  )
  await render()
  expect(item('answer')).toBe(answer)
  expect(answer?.textContent).toContain('appended')
  expect(answer?.dataset.streaming).toBe('true')
  nodes = nodes.map((node) =>
    node.id === 'tool' && node.kind === 'tool'
      ? { ...node, status: 'failed', resultPreview: 'Denied' }
      : node.id === 'decision' && node.kind === 'approval'
        ? { ...node, state: 'decided', decision: { verdict: 'rejected', via: 'web' } }
        : node,
  )
  await render()
  expect(item('tool')).toBe(toolArticle)
  expect(toolArticle?.dataset.status).toBe('failed')
  expect(toolArticle?.textContent).toContain('Denied')
  expect(item('decision')).toBe(decision)
  expect(decision?.dataset.state).toBe('decided')
  expect(decision?.textContent).toContain('Rejected')
  await act(async () => locale.setLocale('zh-CN'))
  expect(decision?.textContent).toContain('已拒绝')
  expect(toolArticle?.getAttribute('aria-label')).toContain('失败')
  await act(async () =>
    locale.register('override', { 'zh-CN': { 'activity.approval.rejected': '新审批文案' } }),
  )
  expect(decision?.textContent).toContain('新审批文案')
  await act(async () => theme.setTheme('dark'))
  expect(host.querySelector('[data-testid="theme-card"]')).toBe(themeButton)
  expect(themeButton?.textContent).toBe('dark')
  expect(document.activeElement).toBe(themeButton)
  expect(item('answer')).toBe(answer)
  off()
})
