/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resourceAdminShellLocaleCatalog } from '@agnes/resource-control-web/locale-shell'
import {
  PLUGIN_ADMIN_LOCALE_NAMESPACE,
  pluginAdminLocaleCatalog,
} from '@agnes/web-admin/admin/plugins/locales/admin'
import { pluginAdminShellLocaleCatalog } from '@agnes/web-admin/admin/plugins/locales/shell'
import { createDocumentLocaleSource, materializeSettingsControls } from '@agnes/web-ui'
import { SettingsPaneBuiltin } from '@agnes/web-units'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  document.documentElement.lang = 'en'
  document.documentElement.removeAttribute('data-agnes-shell')
  document.documentElement.replaceChildren(document.createElement('head'), document.createElement('body'))
  localStorage.clear()
})

it('translates the standalone admin shell during the blocking boot script', async () => {
  const html = readFileSync(join(process.cwd(), 'packages/web/public/admin.html'), 'utf8')
    .replace(/<link rel="stylesheet" href="\/(?:style|antd|tokens)\.css" \/>/g, '')
    .replace('<script type="module" src="/admin-standalone.js"></script>', '')
  document.body.remove()
  localStorage.setItem('agnes-locale', 'zh-CN')
  vi.resetModules()

  await import('../src/theme-boot.js')
  document.documentElement.innerHTML = html
  document.dispatchEvent(new Event('DOMContentLoaded'))

  expect(document.querySelector('h1')?.textContent).toBe('运行时设置')
  expect(document.querySelector('#source-form button[type="submit"]')?.textContent).toBe('检查内容')
})

it.each(['resources.html', 'index.html'])(
  'translates the MCP transports and confirmation in %s on the blocking boot path',
  async (page) => {
    document.documentElement.innerHTML = readFileSync(
      join(process.cwd(), 'packages/web/public', page),
      'utf8',
    )
      .replace(/<link rel="stylesheet" href="\/(?:style|antd|tokens)\.css" \/>/g, '')
      .replace('<script type="module" src="/resources-standalone.js"></script>', '')
    localStorage.setItem('agnes-locale', 'zh-CN')
    vi.resetModules()
    materializeSettingsControls(document)

    await import('../src/theme-boot.js')

    expect(document.querySelector('#admin-confirm .eyebrow')?.textContent).toBe('需要确认')
    const transport = document.querySelector<HTMLSelectElement>('#mcp-transport')
    expect(Array.from(transport?.options ?? [], (option) => option.value)).toEqual(['stdio', 'http', 'sse'])
    expect(transport?.querySelector('[value="sse"]')?.textContent).toBe('SSE（远程，旧版协议）')
    window.dispatchEvent(new CustomEvent('agnes:locale-changed', { detail: 'en' }))
    expect(transport?.querySelector('[value="sse"]')?.textContent).toBe('SSE (remote, legacy protocol)')
  },
)

it('updates the plugin admin static shell when the document locale changes', () => {
  document.documentElement.innerHTML = readFileSync(
    join(process.cwd(), 'packages/web/public/admin.html'),
    'utf8',
  )
    .replace(/<link rel="stylesheet" href="\/(?:style|antd|tokens)\.css" \/>/g, '')
    .replace('<script src="/theme.js"></script>', '')
    .replace('<script type="module" src="/admin-standalone.js"></script>', '')
  const locale = createDocumentLocaleSource({
    [PLUGIN_ADMIN_LOCALE_NAMESPACE]: pluginAdminLocaleCatalog,
  })

  expect(document.querySelector('h1')?.textContent).toBe('Runtime settings')
  expect(document.querySelector('#source-form button[type="submit"]')?.textContent).toBe('Check source')

  localStorage.setItem('agnes-locale', 'zh-CN')
  document.documentElement.lang = 'zh-CN'
  window.dispatchEvent(new Event('agnes:locale-changed'))

  expect(document.querySelector('h1')?.textContent).toBe('运行时设置')
  expect(document.querySelector('#source-form button[type="submit"]')?.textContent).toBe('检查内容')
  expect(document.getElementById('admin-confirm-title')?.textContent).toBe('确认操作')
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    expect(node.textContent).toBe(locale.source.t(node.dataset.i18n ?? ''))
  }
  for (const [selector, attribute, marker] of [
    ['[data-i18n-aria]', 'aria-label', 'data-i18n-aria'],
    ['[data-i18n-placeholder]', 'placeholder', 'data-i18n-placeholder'],
    ['[data-i18n-title]', 'title', 'data-i18n-title'],
  ] as const) {
    for (const node of document.querySelectorAll<HTMLElement>(selector)) {
      expect(node.getAttribute(attribute)).toBe(locale.source.t(node.getAttribute(marker) ?? ''))
    }
  }
  locale.dispose()
})

it('translates mounted plugin and resource settings panes with their owning catalogs', () => {
  const pluginHost = document.createElement('div')
  const resourceHost = document.createElement('div')
  document.body.append(pluginHost, resourceHost)
  const pluginRoot = createRoot(pluginHost)
  const resourceRoot = createRoot(resourceHost)
  flushSync(() => {
    pluginRoot.render(createElement(SettingsPaneBuiltin, { pane: 'plugin' }))
    resourceRoot.render(createElement(SettingsPaneBuiltin, { pane: 'resources' }))
  })
  document.documentElement.lang = 'zh-CN'
  const locale = createDocumentLocaleSource({
    plugin: pluginAdminShellLocaleCatalog,
    resources: resourceAdminShellLocaleCatalog,
  })

  expect(pluginHost.querySelector('#install-source')?.textContent).toBe('从来源安装')
  expect(resourceHost.querySelector('#skill-refresh')?.textContent).toBe('刷新技能目录')

  document.documentElement.lang = 'en'
  window.dispatchEvent(new Event('agnes:locale-changed'))
  expect(pluginHost.querySelector('#install-source')?.textContent).toBe('Install from source')
  expect(resourceHost.querySelector('#skill-refresh')?.textContent).toBe('Refresh skills catalog')

  locale.dispose()
  pluginRoot.unmount()
  resourceRoot.unmount()
})
