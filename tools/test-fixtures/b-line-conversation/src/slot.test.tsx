import { type ThreadMessage, useMessage, useThread } from '@assistant-ui/react'
import { act, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../../../../packages/cordis/src/index.js'
import type { UINode } from '../../../../packages/protocol/src/index.js'
import {
  type PluginEventSource,
  startPluginHotReload,
} from '../../../../packages/web/src/client-modules/hot-reload.js'
import { mountSlotCard, observeSlotCards } from '../../../../packages/web/src/client-modules/timeline-slot.js'
import { SlotRegistry } from '../../../../packages/web-client/src/registry.js'
import { RuntimeFixture } from './runtime-fixture.js'

const slot = (n: number): UINode => ({
  kind: 'slot',
  id: 'slot-1',
  seq: 1,
  fill: { slot: 'tool.card.inline', extId: 'plugin-a', payload: { n } },
})

function slotMessage(registry?: SlotRegistry) {
  return function SlotMessage() {
    const message = useMessage()
    const node = message.metadata.custom.node as UINode
    const host = useRef<HTMLDivElement>(null)
    const mounted = useRef<ReturnType<typeof mountSlotCard> | undefined>(undefined)
    const mountNode = useRef(node)
    if (mountNode.current.id !== message.id) mountNode.current = node
    useLayoutEffect(() => {
      const initial = mountNode.current
      if (initial.kind !== 'slot' || !host.current || initial.id !== message.id) return
      const card = mountSlotCard({
        node: initial,
        ...(registry ? { context: { registry, claim: (entry, extId) => entry.owner === extId } } : {}),
      })
      host.current.append(card.element)
      mounted.current = card
      return () => {
        card.element.remove()
        mounted.current = undefined
      }
    }, [message.id])
    useLayoutEffect(() => {
      if (node.kind === 'slot') mounted.current?.update(node)
    }, [node])
    return <article data-node-id={message.id} data-node-kind="slot" ref={host} />
  }
}

/** Candidate mixed boundary: assistant-ui supplies state; web owns keyed slot DOM. */
function webKeyedList(registry: SlotRegistry) {
  function KeyedNode({ message }: { message: ThreadMessage }) {
    const node = message.metadata.custom.node as UINode
    const host = useRef<HTMLElement>(null)
    const mounted = useRef<ReturnType<typeof mountSlotCard> | undefined>(undefined)
    const mountNode = useRef(node)
    if (mountNode.current.id !== message.id) mountNode.current = node
    useLayoutEffect(() => {
      const initial = mountNode.current
      if (initial.kind !== 'slot' || !host.current || initial.id !== message.id) return
      const card = mountSlotCard({
        node: initial,
        context: { registry, claim: (entry, extId) => entry.owner === extId },
      })
      host.current.append(card.element)
      mounted.current = card
      return () => {
        card.element.remove()
        mounted.current = undefined
      }
    }, [message.id])
    useLayoutEffect(() => {
      if (node.kind === 'slot') mounted.current?.update(node)
    }, [node])
    return <article data-node-id={message.id} data-node-kind={node.kind} ref={host} />
  }
  return function WebKeyedList() {
    const messages = useThread((state) => state.messages)
    return (
      <>
        {messages.map((message) => (
          <KeyedNode key={message.id} message={message} />
        ))}
      </>
    )
  }
}

let host: HTMLDivElement
let root: Root
let stopObserving: (() => void) | undefined
let contexts: Context[]

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  contexts = []
  stopObserving = observeSlotCards(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  await Promise.resolve()
  stopObserving?.()
  for (const ctx of contexts) await ctx.fiber.dispose()
  document.body.replaceChildren()
})

describe('B-0 / S2 actual web-client SlotOutlet boundary', () => {
  it('shows the existing static fallback when the client-module registry is unavailable', async () => {
    const SlotMessage = slotMessage()
    await act(async () =>
      root.render(
        <RuntimeFixture
          projection={{ sessionId: 's1', nodes: [slot(1)] }}
          mode="repository"
          messageComponent={SlotMessage}
        />,
      ),
    )
    expect(host.querySelector('[data-slot-state="empty"]')?.textContent).toBe('此卡片的插件未就绪')
  })

  it('keeps the slot container and stateful plugin mounted across message and unrelated registry updates', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SlotRegistry)
    const registry = (ctx as unknown as { slots: SlotRegistry }).slots
    const SlotMessage = slotMessage(registry)
    let mounts = 0
    let unmounts = 0
    function PluginCard() {
      const [count, setCount] = useState(0)
      useEffect(() => {
        mounts += 1
        return () => {
          unmounts += 1
        }
      }, [])
      return (
        <button type="button" data-plugin-card="1" onClick={() => setCount((value) => value + 1)}>
          {count}
        </button>
      )
    }
    const render = async (node: UINode) => {
      await act(async () =>
        root.render(
          <RuntimeFixture
            projection={{ sessionId: 's1', nodes: [node] }}
            mode="repository"
            messageComponent={SlotMessage}
          />,
        ),
      )
    }
    await render(slot(1))
    const cardHost = host.querySelector<HTMLElement>('[data-slot-node="tool.card.inline"]')
    expect(cardHost).toBeTruthy()
    expect(cardHost?.textContent).toContain('此槽位的插件未就绪')

    let remove!: () => void
    await act(async () => {
      remove = registry.register(
        { name: 'tool.card.inline', id: 'plugin-card', owner: 'plugin-a' },
        PluginCard,
      )
    })
    await vi.waitFor(() => expect(host.querySelector('[data-plugin-card]')).toBeTruthy())
    const button = host.querySelector<HTMLButtonElement>('[data-plugin-card]')
    await act(async () => button?.click())
    expect(button?.textContent).toBe('1')
    expect(mounts).toBe(1)

    await render(slot(2))
    expect(host.querySelector('[data-slot-node]')).toBe(cardHost)
    expect(host.querySelector('[data-plugin-card]')).toBe(button)
    expect(button?.textContent).toBe('1')
    expect(mounts).toBe(1)
    expect(unmounts).toBe(0)

    let removeUnrelated!: () => void
    await act(async () => {
      removeUnrelated = registry.register(
        { name: 'tool.card.inline', id: 'unrelated', owner: 'plugin-b' },
        () => <span>other</span>,
      )
    })
    await act(async () => removeUnrelated())
    expect(host.querySelector('[data-plugin-card]')).toBe(button)
    expect(button?.textContent).toBe('1')
    expect(mounts).toBe(1)
    expect(unmounts).toBe(0)

    await act(async () => remove())
    await vi.waitFor(() => expect(host.querySelector('[data-plugin-card]')).toBeNull())
    expect(host.querySelector('[data-slot-node]')).toBe(cardHost)
    expect(cardHost?.textContent).toContain('此槽位的插件未就绪')
    await act(async () =>
      root.render(
        <RuntimeFixture
          projection={{ sessionId: 's1', nodes: [] }}
          mode="repository"
          messageComponent={SlotMessage}
        />,
      ),
    )
    await vi.waitFor(() => expect(host.querySelector('[data-slot-node]')).toBeNull())
    expect(unmounts).toBe(1)
  })

  it.fails('prepending history through ThreadPrimitive.Messages keeps an existing slot instance alive', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SlotRegistry)
    const registry = (ctx as unknown as { slots: SlotRegistry }).slots
    const SlotMessage = slotMessage(registry)
    function PluginCard() {
      const [count, setCount] = useState(0)
      return (
        <button type="button" data-plugin-card="1" onClick={() => setCount((value) => value + 1)}>
          {count}
        </button>
      )
    }
    registry.register({ name: 'tool.card.inline', id: 'plugin-card', owner: 'plugin-a' }, PluginCard)
    const render = async (nodes: UINode[]) => {
      await act(async () =>
        root.render(
          <RuntimeFixture
            projection={{ sessionId: 's1', nodes }}
            mode="repository"
            messageComponent={SlotMessage}
          />,
        ),
      )
    }
    const current = slot(1)
    await render([current])
    await vi.waitFor(() => expect(host.querySelector('[data-plugin-card]')).toBeTruthy())
    const cardHost = host.querySelector('[data-slot-node]')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-plugin-card]')?.click())
    expect(host.querySelector('[data-plugin-card]')?.textContent).toBe('1')

    await render([
      { kind: 'user', id: 'earlier', seq: 0, content: [{ type: 'text', text: 'history' }] },
      current,
    ])
    await vi.waitFor(() => expect(host.querySelector('[data-plugin-card]')).toBeTruthy())
    expect(host.querySelector('[data-slot-node]')).toBe(cardHost)
    expect(host.querySelector('[data-plugin-card]')?.textContent).toBe('1')
  })

  it.fails('keyed MessageByIndex retains a stateful slot across a history prepend', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SlotRegistry)
    const registry = (ctx as unknown as { slots: SlotRegistry }).slots
    const SlotMessage = slotMessage(registry)
    function PluginCard() {
      const [count, setCount] = useState(0)
      return (
        <button type="button" data-plugin-card="1" onClick={() => setCount((value) => value + 1)}>
          {count}
        </button>
      )
    }
    registry.register({ name: 'tool.card.inline', id: 'plugin-card', owner: 'plugin-a' }, PluginCard)
    const render = async (nodes: UINode[]) => {
      await act(async () =>
        root.render(
          <RuntimeFixture
            projection={{ sessionId: 's1', nodes }}
            mode="repository"
            listRenderer="keyed-index"
            messageComponent={SlotMessage}
          />,
        ),
      )
    }
    const current = slot(1)
    await render([current])
    await vi.waitFor(() => expect(host.querySelector('[data-plugin-card]')).toBeTruthy())
    const cardHost = host.querySelector('[data-slot-node]')
    const button = host.querySelector('[data-plugin-card]')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-plugin-card]')?.click())
    expect(button?.textContent).toBe('1')

    await render([
      { kind: 'user', id: 'earlier', seq: 0, content: [{ type: 'text', text: 'history' }] },
      current,
    ])
    await vi.waitFor(() => expect(host.querySelector('[data-plugin-card]')).toBeTruthy())
    expect(host.querySelector('[data-slot-node]')).toBe(cardHost)
    expect(host.querySelector('[data-plugin-card]')).toBe(button)
    expect(button?.textContent).toBe('1')
  })

  it('web-owned keyed slot leaf retains its container and state across a history prepend', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SlotRegistry)
    const registry = (ctx as unknown as { slots: SlotRegistry }).slots
    const KeyedList = webKeyedList(registry)
    function PluginCard() {
      const [count, setCount] = useState(0)
      return (
        <button type="button" data-plugin-card="1" onClick={() => setCount((value) => value + 1)}>
          {count}
        </button>
      )
    }
    registry.register({ name: 'tool.card.inline', id: 'plugin-card', owner: 'plugin-a' }, PluginCard)
    const render = async (nodes: UINode[]) => {
      await act(async () =>
        root.render(
          <RuntimeFixture projection={{ sessionId: 's1', nodes }} mode="repository" keyedList={KeyedList} />,
        ),
      )
    }
    const current = slot(1)
    await render([current])
    await vi.waitFor(() => expect(host.querySelector('[data-plugin-card]')).toBeTruthy())
    const cardHost = host.querySelector('[data-slot-node]')
    const button = host.querySelector('[data-plugin-card]')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-plugin-card]')?.click())
    expect(button?.textContent).toBe('1')
    await render([
      { kind: 'user', id: 'earlier', seq: 0, content: [{ type: 'text', text: 'history' }] },
      current,
    ])
    await vi.waitFor(() => expect(host.querySelector('[data-plugin-card]')).toBeTruthy())
    expect(host.querySelector('[data-slot-node]')).toBe(cardHost)
    expect(host.querySelector('[data-plugin-card]')).toBe(button)
    expect(button?.textContent).toBe('1')
  })

  it.fails('an SSE rebuild that replaces the registered component preserves plugin-local React state', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SlotRegistry)
    const registry = (ctx as unknown as { slots: SlotRegistry }).slots
    const SlotMessage = slotMessage(registry)
    function PluginCard() {
      const [count, setCount] = useState(0)
      return (
        <button type="button" data-plugin-card="1" onClick={() => setCount((value) => value + 1)}>
          {count}
        </button>
      )
    }
    let remove!: () => void
    await act(async () => {
      remove = registry.register(
        { name: 'tool.card.inline', id: 'plugin-card', owner: 'plugin-a' },
        PluginCard,
      )
      root.render(
        <RuntimeFixture
          projection={{ sessionId: 's1', nodes: [slot(1)] }}
          mode="repository"
          messageComponent={SlotMessage}
        />,
      )
    })
    await vi.waitFor(() => expect(host.querySelector('[data-plugin-card]')).toBeTruthy())
    await act(async () => host.querySelector<HTMLButtonElement>('[data-plugin-card]')?.click())
    expect(host.querySelector('[data-plugin-card]')?.textContent).toBe('1')
    class FakeEventSource implements PluginEventSource {
      listeners = new Map<string, (event: { data: string }) => void>()
      addEventListener(type: 'graph' | 'rebuilt', listener: (event: { data: string }) => void) {
        this.listeners.set(type, listener)
      }
      removeEventListener(type: 'graph' | 'rebuilt') {
        this.listeners.delete(type)
      }
      close() {
        this.listeners.clear()
      }
      emitRebuilt() {
        this.listeners.get('rebuilt')?.({
          data: JSON.stringify({ type: 'rebuilt', id: 'plugin-a', rev: 'new' }),
        })
      }
    }
    let source!: FakeEventSource
    const stop = startPluginHotReload({
      EventSource: class extends FakeEventSource {
        constructor() {
          super()
          source = this
        }
      },
      reconciler: {
        reload: async () => {
          remove()
          registry.register(
            { name: 'tool.card.inline', id: 'plugin-card-new', owner: 'plugin-a' },
            PluginCard,
          )
        },
        reconcileNow: async () => undefined,
        invalidate: async () => undefined,
        subscribe: () => () => undefined,
        snapshot: () => new Map(),
      },
    })
    await act(async () => {
      source.emitRebuilt()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await vi.waitFor(() => expect(host.querySelector('[data-plugin-card]')).toBeTruthy())
    stop()
    expect(host.querySelector('[data-plugin-card]')?.textContent).toBe('1')
  })
})
