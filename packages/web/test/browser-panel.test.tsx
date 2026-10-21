/** @vitest-environment happy-dom */
import type { ClientContext } from '@agnes/web-client'
import { type ComponentType, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { apply } from '../../package-manager/bundled-plugins/browser/src/browser.js'
import { browserCatalog } from '../../package-manager/bundled-plugins/browser/src/browser-locales.js'

const state = {
  sessionId: 'one',
  state: 'failed',
  pages: [],
  error:
    'Browser install lock /private/cache/1243-darwin-arm64.lock has no readable owner (possibly an old directory lock). Confirm no installer is running, then remove this lock manually and retry.',
}
vi.mock('../../package-manager/bundled-plugins/browser/src/browser-client.js', () => ({
  BrowserClient: class {
    subscribe = () => () => {}
    getSnapshot = () => state
    start = () => () => {}
    pendingEffect = () => undefined
    close() {}
  },
}))
vi.mock('../../package-manager/bundled-plugins/browser/src/browser-interaction.js', () => ({
  BrowserInteraction: class {
    async prepare() {}
    close() {}
  },
}))
vi.mock('@agnes/web-ui', async () => {
  const { createElement } = await import('react')
  return {
    Button: ({ children, onClick }: { children: string; onClick(): void }) =>
      createElement('button', { onClick }, children),
    SettingsInput: () => null,
    IconButton: () => null,
    Menu: () => null,
    Tabs: () => null,
  }
})

it('shows one-click legacy lock guidance with the full path and copies it without deleting anything', async () => {
  let Panel: ComponentType | undefined
  const ctx = {
    locale: {
      t: (key: string) => browserCatalog['zh-CN'][key as keyof (typeof browserCatalog)['zh-CN']] ?? key,
      subscribe: () => () => {},
      getSnapshot: () => 'zh-CN',
      register: () => () => {},
    },
    session: { readiness: { subscribe: () => () => {} } },
    workbenchPanels: {
      register: (panel: { component: ComponentType }) => {
        Panel = panel.component
        return () => {}
      },
    },
  } as unknown as ClientContext
  const dispose = apply(ctx)
  const host = document.createElement('div')
  const root = createRoot(host)
  const copy = vi.fn(async (_text: string) => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
  try {
    if (!Panel) throw new Error('missing browser panel')
    flushSync(() => root.render(createElement(Panel)))
    expect(host.textContent).toContain(state.error)
    const help = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '查看安装锁恢复步骤',
    )
    flushSync(() => help?.click())
    expect(host.textContent).toContain('旧目录锁没有所有者身份')
    expect(host.textContent).toContain('/private/cache/1243-darwin-arm64.lock')
    const button = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '复制恢复步骤和精确路径',
    )
    if (!button) throw new Error('missing recovery action')
    button.click()
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(expect.stringContaining(state.error)))
  } finally {
    flushSync(() => root.unmount())
    dispose()
  }
})
