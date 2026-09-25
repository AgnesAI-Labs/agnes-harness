/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type { UINode } from '@agnes/protocol'
import { SlotRegistry } from '@agnes/web-client'
import { createConversationProjectionStore, useConversationRuntime } from '@agnes/web-ui/assistant-ui'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { act, createElement, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebConversationMessages } from '../src/conversation-message-adapter.js'

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
const tool = (status: Extract<UINode, { kind: 'tool' }>['status']): UINode => ({
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

  it('uses the original tool card, cost detail and Markdown leaves, with DSH toolview claim and fallback', async () => {
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
  })
})
