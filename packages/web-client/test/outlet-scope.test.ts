/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import { createElement, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SlotOutlet, SlotRegistry, SlotsProvider } from '../src/index.js'

it.each(['single', 'chain'] as const)(
  'preserves root %s entries while replacing session entries',
  async (kind) => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry)
    const registry = (ctx as unknown as { slots: SlotRegistry }).slots
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const stores = { root: vi.fn(), session: vi.fn() }
    const destroyed = vi.fn()
    function Counter() {
      const [count, setCount] = useState(0)
      return createElement('button', { type: 'button', onClick: () => setCount(count + 1) }, count)
    }
    try {
      registry.setSession('one')
      for (const scope of ['root', 'session'] as const) {
        registry.declare(`test-${scope}`, { kind, scope })
        registry.register(
          {
            name: `test-${scope}`,
            ...(kind === 'chain' ? { select: () => true } : {}),
            store: (key) => {
              stores[scope](key)
              return { getSnapshot: () => 0, subscribe: () => () => {}, actions: {}, destroy: destroyed }
            },
          },
          Counter,
        )
      }
      flushSync(() =>
        root.render(
          createElement(
            SlotsProvider,
            { registry },
            createElement(SlotOutlet, { name: 'test-root' as never }),
            createElement(SlotOutlet, { name: 'test-session' as never }),
          ),
        ),
      )
      const buttons = [...container.querySelectorAll('button')]
      flushSync(() => {
        for (const button of buttons) button.click()
      })
      expect(buttons.map((button) => button.textContent)).toEqual(['1', '1'])
      flushSync(() => registry.setSession('two'))
      expect(container.querySelectorAll('button')[0]).toBe(buttons[0])
      expect(container.querySelectorAll('button')[1]).not.toBe(buttons[1])
      expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
        '1',
        '0',
      ])
      expect(stores.root.mock.calls).toEqual([['root']])
      expect(stores.session.mock.calls).toEqual([['one'], ['two']])
      expect(destroyed).toHaveBeenCalledTimes(1)
      flushSync(() => registry.setSession(undefined))
      expect(container.querySelectorAll('button')).toHaveLength(1)
      expect(container.querySelector('button')).toBe(buttons[0])
      expect(destroyed).toHaveBeenCalledTimes(2)
    } finally {
      root.unmount()
      await ctx.fiber.dispose()
      container.remove()
    }
  },
)

it('hides an empty chain outlet when the host requests a silent fallback', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const registry = (ctx as unknown as { slots: SlotRegistry }).slots
  registry.declare('empty-chain', { kind: 'chain', scope: 'root' })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    flushSync(() =>
      root.render(
        createElement(
          SlotsProvider,
          { registry },
          createElement(SlotOutlet, { name: 'empty-chain' as never, hideWhenEmpty: true }),
        ),
      ),
    )
    const outlet = container.querySelector('[data-slot="empty-chain"]')
    expect(outlet).not.toBeNull()
    expect((outlet as HTMLElement).hidden).toBe(true)
    expect(outlet?.textContent).toBe('')
  } finally {
    root.unmount()
    await ctx.fiber.dispose()
    container.remove()
  }
})
