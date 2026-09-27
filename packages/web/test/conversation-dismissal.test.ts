/** @vitest-environment happy-dom */

import type { UINode, UITurn } from '@agnes/protocol'
import { createConversationProjectionStore, useConversationRuntime } from '@agnes/web-ui/assistant-ui'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WebConversationMessages } from '../src/conversation-message-adapter.js'
import { createTimelineRenderer } from '../src/timeline.js'

const nodes: UINode[] = [
  { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'question' }] },
  { kind: 'assistant', id: 'a1', seq: 2, text: 'answer' },
]
const turn: UITurn = {
  id: 'turn:1',
  turn: 1,
  startSeq: 1,
  endSeq: 2,
  startedAt: '2026-09-27T00:00:00.000Z',
  endedAt: '2026-09-27T00:00:01.000Z',
  status: 'completed',
  nodeIds: ['u1', 'a1'],
  finalAssistantId: 'a1',
  inherited: false,
  forkable: false,
  usage: {
    totals: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: true,
    billingComplete: true,
    calls: [],
  },
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function required<T extends Element>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector<T>(selector)
  if (!element) throw new Error(`missing ${selector}`)
  return element
}

it('retires legacy turn actions when the projection loses its turn list, then supports another turn', () => {
  const host = document.createElement('section')
  document.body.append(host)
  const add = vi.spyOn(document, 'addEventListener')
  const remove = vi.spyOn(document, 'removeEventListener')
  const timeline = createTimelineRenderer({
    transcript: host,
    newContentButton: document.createElement('button'),
  })
  try {
    timeline.render(nodes, [turn])
    const click = add.mock.calls.find(([type]) => type === 'click')?.[1]
    expect(click).toBeDefined()
    const old = required<HTMLDetailsElement>(host, '.turn-usage')
    timeline.render(nodes, [])
    expect(host.querySelector('.turn-usage')).toBeNull()
    expect(remove.mock.calls.some(([type, listener]) => type === 'click' && listener === click)).toBe(true)
    timeline.render(nodes, [turn])
    const next = required<HTMLDetailsElement>(host, '.turn-usage')
    expect(next).not.toBe(old)
    expect(host.textContent).toContain('answer')
    next.open = true
    document.body.click()
    expect(next.open).toBe(false)
  } finally {
    timeline.dispose?.()
  }
})

it('keeps the React adapter disclosure through replay and retires its binding on unmount/remount', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  const host = document.createElement('section')
  document.body.append(host)
  const root = createRoot(host)
  const store = createConversationProjectionStore({ sessionId: 'session', nodes, turns: [turn] })
  function Harness() {
    const runtime = useConversationRuntime(store)
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(WebConversationMessages, { turns: [turn] }),
    )
  }
  const add = vi.spyOn(document, 'addEventListener')
  const remove = vi.spyOn(document, 'removeEventListener')
  try {
    await act(async () => root.render(createElement(Harness)))
    const old = required<HTMLDetailsElement>(host, '.turn-usage')
    const summary = required<HTMLElement>(old, 'summary')
    const click = add.mock.calls.find(([type]) => type === 'click')?.[1]
    expect(click).toBeDefined()
    old.open = true
    summary.focus()
    await act(async () => store.update({ sessionId: 'session', nodes, turns: [turn] }))
    expect(host.querySelector('.turn-usage')).toBe(old)
    expect(old.open).toBe(true)
    expect(document.activeElement).toBe(summary)
    required<HTMLElement>(old, 'dl').click()
    expect(old.open).toBe(true)
    document.body.click()
    expect(old.open).toBe(false)
    await act(async () => root.render(null))
    expect(remove.mock.calls.some(([type, listener]) => type === 'click' && listener === click)).toBe(true)
    await act(async () => root.render(createElement(Harness)))
    expect(host.querySelectorAll('.turn-usage')).toHaveLength(1)
    expect(host.querySelector('.turn-usage')).not.toBe(old)
    expect(
      [...host.querySelectorAll('[data-node-id]')].map((node) => node.getAttribute('data-node-id')),
    ).toEqual(['u1', 'a1'])
    const next = required<HTMLDetailsElement>(host, '.turn-usage')
    next.open = true
    document.body.click()
    expect(next.open).toBe(false)
  } finally {
    await act(async () => root.unmount())
  }
})
