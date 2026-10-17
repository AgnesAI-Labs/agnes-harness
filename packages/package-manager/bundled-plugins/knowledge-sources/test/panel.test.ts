// @vitest-environment happy-dom
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

const registry = vi.hoisted(() => new Map<string, { component: () => unknown }>())
vi.mock('@agnes/web-client', () => ({
  workbenchPanels: {
    register(entry: { id: string; component: () => unknown }) {
      registry.set(entry.id, entry)
      return () => registry.delete(entry.id)
    },
  },
}))
vi.mock('@agnes/web-ui', () => ({
  Button: ({ children, htmlType, ...props }: Record<string, unknown>) =>
    h('button', { ...props, type: htmlType }, children as string),
  MetaText: ({ children }: { children: string }) => h('span', null, children),
  SettingsState: ({ children, tone }: { children: string; tone: string }) =>
    h('div', { role: tone === 'error' ? 'alert' : 'status' }, children),
  Tag: ({ children }: { children: string }) => h('span', null, children),
}))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean()
  registry.clear()
})
async function mount(locale: string, call: (name: string, input: unknown) => Promise<unknown>) {
  const { KnowledgePanel, apply } = await import('../client/index.js')
  const listeners = new Set<() => void>()
  const ctx = {
    session: {
      sessionId: 'alice',
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      getSnapshot: () => ctx.session.sessionId,
    },
    locale: { locale, subscribe: () => () => {}, getSnapshot: () => locale },
    agnes: { services: { call } },
  }
  const dispose = apply(ctx)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(h(KnowledgePanel, { ctx }))
  })
  cleanups.push(() => {
    act(() => root.unmount())
    dispose()
    container.remove()
  })
  return { container, ctx, listeners, dispose, root }
}
it.each(['en', 'zh-CN'])(
  'renders localized empty/error feedback and releases the panel for %s',
  async (locale) => {
    const call = vi.fn(async () => ({ sources: [], citations: [] }))
    const f = await mount(locale, call)
    expect(f.container.textContent).toContain(locale === 'en' ? 'No citations yet' : '暂无引用')
    expect(f.container.querySelector('button')?.getAttribute('type')).toBe('button')
    call.mockRejectedValueOnce(new Error('private backend diagnostics'))
    await act(async () => {
      f.container.querySelector('button')?.click()
    })
    expect(f.container.querySelector('[role="alert"]')?.textContent).toContain(
      locale === 'en' ? 'unavailable' : '不可用',
    )
    expect(f.container.textContent).not.toContain('private backend')
    f.dispose()
    expect(registry.has('knowledge-sources')).toBe(false)
  },
)
it('renders untrusted originals as text, blocks revoked/stale reads, and drops a switched-session response', async () => {
  const citation = {
    id: 'a'.repeat(64),
    sourceId: 'policy',
    locator: 'synthetic:policy',
    revision: 'r1',
    excerptHash: 'b'.repeat(64),
    retrievedAt: '2026-01-01T00:00:00Z',
  }
  let pending: ((value: unknown) => void) | undefined
  const call = vi.fn(async (name: string) =>
    name === 'knowledge.history'
      ? {
          sources: [{ id: 'policy' }],
          citations: ['current', 'stale', 'revoked'].map((status) => ({ ...citation, id: status, status })),
        }
      : new Promise((resolve) => {
          pending = resolve
        }),
  )
  const f = await mount('en', call)
  const reads = [...f.container.querySelectorAll('article button')] as HTMLButtonElement[]
  expect(reads.map((button) => button.disabled)).toEqual([false, true, true])
  await act(async () => {
    reads[0]?.click()
  })
  await act(async () => {
    pending?.({ status: 'current', excerpt: '<script>injected()</script>' })
  })
  expect(f.container.querySelector('pre')?.textContent).toBe('<script>injected()</script>')
  expect(f.container.querySelector('script')).toBeNull()
  await act(async () => {
    reads[0]?.click()
  })
  await act(async () => {
    f.ctx.session.sessionId = 'bob'
    for (const notify of f.listeners) notify()
  })
  await act(async () => {
    pending?.({ status: 'current', excerpt: 'Alice late private text' })
  })
  expect(f.container.textContent).not.toContain('Alice late private text')
})
