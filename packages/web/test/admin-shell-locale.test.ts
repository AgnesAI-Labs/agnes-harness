/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resourceAdminShellLocaleCatalog } from '@agnes/resource-control-web/locale-shell'
import {
  PLUGIN_ADMIN_LOCALE_NAMESPACE,
  pluginAdminLocaleCatalog,
} from '@agnes/web-admin/admin/plugins/locales/admin'
import { pluginAdminShellLocaleCatalog } from '@agnes/web-admin/admin/plugins/locales/shell'
import { createDocumentLocaleSource, materializeSettingsControls } from '@agnes/web-ui'
import { SettingsPaneBuiltin } from '@agnes/web-units'
import { createElement, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

let disposeShell: (() => void) | undefined
afterEach(() => {
  disposeShell?.()
  disposeShell = undefined
  document.documentElement.lang = 'en'
  document.documentElement.removeAttribute('data-agnes-shell')
  document.documentElement.replaceChildren(document.createElement('head'), document.createElement('body'))
  localStorage.clear()
})

it('translates the MCP transports and confirmation of the workbench on the blocking boot path', async () => {
  document.documentElement.innerHTML = readFileSync(
    join(resolve(import.meta.dirname, '../../..'), 'packages/web/public/index.html'),
    'utf8',
  ).replace(/<link rel="stylesheet" href="\/(?:style|antd|tokens)\.css" \/>/g, '')
  localStorage.setItem('agnes-locale', 'zh-CN')
  vi.resetModules()

  await import('../src/theme-boot.js')
  const { mountAppShell } = await import('../src/app-shell.js')
  disposeShell = mountAppShell()

  expect(document.querySelector('#admin-confirm .eyebrow')?.textContent).toBe('需要确认')
  const transport = document.querySelector<HTMLSelectElement>('#mcp-transport')
  expect(Array.from(transport?.options ?? [], (option) => option.value)).toEqual(['stdio', 'http', 'sse'])
  expect(transport?.querySelector('[value="sse"]')?.textContent).toBe('SSE（远程，旧版协议）')
  window.dispatchEvent(new CustomEvent('agnes:locale-changed', { detail: 'en' }))
  await vi.waitFor(() =>
    expect(transport?.querySelector('[value="sse"]')?.textContent).toBe('SSE (remote, legacy protocol)'),
  )
})

it('translates mounted plugin and resource settings panes with their owning catalogs', () => {
  document.documentElement.lang = 'zh-CN'
  const locale = createDocumentLocaleSource({
    plugin: pluginAdminShellLocaleCatalog,
    resources: resourceAdminShellLocaleCatalog,
  })
  function Pane({ pane }: { pane: 'plugin' | 'resources' }) {
    useSyncExternalStore(locale.source.subscribe, locale.source.getVersion, locale.source.getVersion)
    return createElement(SettingsPaneBuiltin, { pane, translate: locale.source.bind(pane) })
  }
  const pluginHost = document.createElement('div')
  const resourceHost = document.createElement('div')
  document.body.append(pluginHost, resourceHost)
  const pluginRoot = createRoot(pluginHost)
  const resourceRoot = createRoot(resourceHost)
  flushSync(() => {
    pluginRoot.render(createElement(Pane, { pane: 'plugin' }))
    resourceRoot.render(createElement(Pane, { pane: 'resources' }))
  })
  expect(pluginHost.querySelector('#install-source')?.textContent).toBe('从来源安装')
  expect(resourceHost.querySelector('#skill-refresh')?.textContent).toBe('刷新技能目录')
  const refresh = resourceHost.querySelector('#skill-refresh')
  flushSync(() => {
    document.documentElement.lang = 'en'
    window.dispatchEvent(new Event('agnes:locale-changed'))
  })
  expect(pluginHost.querySelector('#install-source')?.textContent).toBe('Install from source')
  expect(resourceHost.querySelector('#skill-refresh')?.textContent).toBe('Refresh skills catalog')
  expect(resourceHost.querySelector('#skill-refresh')).toBe(refresh)
  expect(document.querySelector('[data-i18n]')).toBeNull()
  locale.dispose()
  pluginRoot.unmount()
  resourceRoot.unmount()
})
