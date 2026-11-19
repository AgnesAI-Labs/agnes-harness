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
  errorCode: undefined as string | undefined,
  error:
    'Browser install lock /private/cache/1243-darwin-arm64.lock has no readable owner (possibly an old directory lock). Confirm no installer is running, then remove this lock manually and retry.',
}
vi.mock('../../package-manager/bundled-plugins/browser/src/browser-client.js', () => ({
  BrowserClient: class {
    subscribe = () => () => {}
    getSnapshot = () => state
    start = () => () => {}
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

function mountPanel() {
  let Panel: ComponentType | undefined
  const selected = { status: 'ready', sessionId: 'one', epoch: 1 }
  const ctx = {
    locale: {
      t: (key: string) => browserCatalog['zh-CN'][key as keyof (typeof browserCatalog)['zh-CN']] ?? key,
      subscribe: () => () => {},
      getSnapshot: () => 'zh-CN',
      register: () => () => {},
    },
    session: { readiness: { subscribe: () => () => {}, getSnapshot: () => selected } },
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
  if (!Panel) throw new Error('missing browser panel')
  const BrowserPanel = Panel
  flushSync(() => root.render(createElement(BrowserPanel)))
  return {
    host,
    close: () => {
      flushSync(() => root.unmount())
      dispose()
    },
  }
}

it('shows one-click legacy lock guidance with the full path and copies it without deleting anything', async () => {
  const { host, close } = mountPanel()
  const copy = vi.fn(async (_text: string) => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
  try {
    expect(host.textContent).toContain(state.error)
    const help = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '查看安装锁恢复步骤',
    )
    flushSync(() => help?.click())
    expect(host.textContent).toContain('旧目录锁无所有者信息')
    expect(host.textContent).toContain('先停止共用此缓存的全部安装进程')
    expect(host.textContent).toContain('确认退出后再移开锁')
    expect(host.textContent).toContain('禁止移除活跃锁')
    expect(host.textContent).toContain('此按钮不修改文件')
    expect(host.textContent).toContain('/private/cache/1243-darwin-arm64.lock')
    const button = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '复制步骤和锁路径',
    )
    if (!button) throw new Error('missing recovery action')
    button.click()
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(expect.stringContaining(state.error)))
  } finally {
    close()
  }
})

it.each([
  ['UNSUPPORTED_MACOS', '内置浏览器需要 macOS 13 Ventura 或更高版本。请升级 macOS 后再使用。'],
  ['VERSION_MISMATCH', '已安装的浏览器组件版本不兼容。请更新 Agnes Harness 后再试。'],
  ['LAUNCH_FAILED', '内置浏览器启动失败。请在「插件」页关闭后重新启用内置浏览器，再试一次。'],
  [undefined, '内置浏览器启动失败。请在「插件」页关闭后重新启用内置浏览器，再试一次。'],
])('renders safe startup guidance for %s even when an older backend sends raw logs', (code, message) => {
  const original = state.error
  state.error =
    'browserType.launch: Target page, context or browser has been closed\nBrowser logs: <launching> /private/chrome'
  state.errorCode = code
  const { host, close } = mountPanel()
  try {
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(message)
    expect(host.textContent).not.toMatch(
      /browserType\.launch|Browser logs|\/private\/chrome|正在自动重连|暂无页面/,
    )
  } finally {
    close()
    state.error = original
    state.errorCode = undefined
  }
})
