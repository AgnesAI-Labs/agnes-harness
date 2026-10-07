/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type { UINode, UITurn } from '@agnes/protocol'
import { SlotRegistry } from '@agnes/web-client'
import {
  AssistantRuntimeProvider,
  createConversationProjectionStore,
  useConversationRuntime,
} from '@agnes/web-ui/assistant-ui'
import { act, createElement, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebConversationMessages } from '../src/conversation-message-adapter.js'
import { costDetails, costSummary } from '../src/usage.js'
import { zhLocaleService, zhT } from './helpers/locale.js'

let host: HTMLDivElement
let root: Root
let ctx: Context
let registry: SlotRegistry

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
  await ctx.fiber.dispose()
  host.remove()
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
  const runtime = useConversationRuntime(store)
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(WebConversationMessages, {
      registry,
      claim: (entry, extId) => entry.owner === extId,
      locale: zhLocaleService(),
    }),
  )
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
    expect(toolElement?.textContent).toContain('正在执行')
    expect(toolElement?.querySelector('svg.icon.tool-icon')?.getAttribute('aria-hidden')).toBe('true')
    const details = item('cost')?.querySelector<HTMLDetailsElement>('details.call-usage')
    expect(details?.textContent).toContain('费用未提供')
    if (details) details.open = true
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
    expect(details?.open).toBe(true)
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
    expect(item('tool')?.querySelector('.tool-status')?.textContent).toBe('等待执行')
  })

  it('updates a tool glyph and retains its disclosure when a tool name changes under the same ID', async () => {
    const initial = tool('running')
    const store = createConversationProjectionStore({ sessionId: 'session', nodes: [initial] })
    await mount(store)
    const card = item('tool')?.querySelector<HTMLElement>('[data-agnes-tool-card]')
    const button = card?.querySelector<HTMLButtonElement>('.tool-detail')
    await act(async () => button?.click())
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
    const detail = item('tool')?.querySelector<HTMLElement>('.tool-detail-text')
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
  const details = article?.querySelector('details')
  const summary = article?.querySelector('summary')
  if (!details || !summary) throw new Error('missing cost disclosure')
  details.open = true
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
    expect(article?.querySelector('details')).toBe(details)
    expect(article?.querySelector('summary')).toBe(summary)
    expect(details.open).toBe(true)
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
    const runtime = useConversationRuntime(store)
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(WebConversationMessages, { registry, turns: [current], locale: zhLocaleService() }),
    )
  }
  await act(async () => root.render(createElement(FailedTurn, { current: turn })))
  const error = host.querySelector<HTMLElement>('.turn-error')
  expect(error?.getAttribute('role')).toBe('alert')
  expect(error?.textContent).toBe(
    withError ? `BUDGET_EXCEEDED：${message}` : '本次执行未完成（budget），暂未收到具体错误信息。',
  )
  expect(error?.closest('.turn-process, .turn-process-body')).toBeNull()
  expect(error?.querySelector('img, strong')).toBeNull()
  expect(host.querySelector<HTMLDetailsElement>('.turn-process')?.open).toBe(false)
  await act(async () =>
    root.render(
      createElement(FailedTurn, { current: { ...turn, status: 'completed', reason: 'completed' } }),
    ),
  )
  expect(host.querySelector('.turn-error')).toBeNull()
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
    const runtime = useConversationRuntime(store)
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(WebConversationMessages, { registry, turns, onFork, locale: zhLocaleService() }),
    )
  }
  await act(async () => root.render(createElement(TurnHarness, { turns: [first, second] })))
  const firstFooter = host.querySelector<HTMLElement>('[data-turn-id="turn:1"] footer.turn-footer')
  const secondFooter = host.querySelector<HTMLElement>('[data-turn-id="turn:2"] footer.turn-footer')
  const secondDetails = secondFooter?.querySelector<HTMLDetailsElement>('.turn-usage')
  const secondSummary = secondDetails?.querySelector<HTMLElement>('summary')
  expect(secondFooter).not.toBeNull()
  expect(secondDetails).not.toBeNull()
  if (!secondDetails || !secondSummary) throw new Error('missing second turn disclosure')
  secondDetails.open = true
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
  expect(secondDetails.open).toBe(true)
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

it('keeps questions, deliverables, jobs and children visible when settled process history collapses', async () => {
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
            question: { id: 'q', questions: [{ id: 'choice', question: 'Pick', options: ['A'] }] },
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
            deliverables: [{ name: 'report.txt', lane: 'main', ref: { sha256: 'a'.repeat(64), size: 6 } }],
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
    const runtime = useConversationRuntime(store)
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(WebConversationMessages, {
        registry,
        nodes: cardNodes,
        turns: [turn],
        locale: zhLocaleService(),
      }),
    )
  }
  await act(async () => root.render(createElement(CardsHarness)))
  expect(host.querySelector<HTMLDetailsElement>('.turn-process')?.open).toBe(false)
  expect(item('tool')?.parentElement?.hidden).toBe(true)
  for (const id of ['question', 'files', 'jobs', 'children', 'approval']) {
    expect(item(id)?.parentElement?.className).toBe('turn-attention')
    expect(item(id)?.parentElement?.hidden).toBe(false)
  }
  for (const id of [
    'question-card',
    'question-submit',
    'deliverable-card',
    'background-job-card',
    'child-agent-card',
  ])
    expect(host.querySelector(`[data-testid="${id}"]`)).not.toBeNull()
  expect(host.querySelector('[data-testid="child-engine-output"]')?.textContent).toContain(
    'child-a completed',
  )
  expect(host.querySelector('[data-testid="child-engine-output"]')?.getAttribute('aria-label')).toBe(
    '子代理引擎输出',
  )
  expect(host.querySelector('[data-testid="question-submit"]')?.textContent).toBe('提交答案')
  expect(host.querySelector('[data-testid="deliverable-card"]')?.getAttribute('aria-label')).toBe(
    '交付物: report.txt',
  )
  await act(async () => host.querySelector<HTMLElement>('[data-testid="turn-process-toggle"]')?.click())
  expect(item('question')?.parentElement?.hidden).toBe(false)
})
