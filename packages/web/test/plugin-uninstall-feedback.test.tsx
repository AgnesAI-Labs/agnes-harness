/** @vitest-environment happy-dom */

import type { PackageInstalledDescriptor, PackageOperation } from '@agnes/protocol'
import { ADMIN_FEATURES } from '@agnes/web-admin/admin/plugins/types'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PluginView } from '../src/pages/plugins/admin-view.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Every case starts from fresh module state, so the page and the controller share one instance.
beforeEach(() => vi.resetModules())

const timestamp = '2026-10-29T00:00:00.000Z'
const ID = '@acme/notes'
const row = {
  id: ID,
  version: '1.0.0',
  source: { type: 'file', ref: 'file:/opt/agnes/plugins/notes' },
  integrity: `sha256-${'7a'.repeat(32)}`,
  trusted: true,
  desired: 'installed-disabled',
  actual: 'not-running',
  cleanupPending: false,
  rollbackTarget: null,
  contributions: [],
  blockers: [],
  capabilityHash: 'e3'.repeat(32),
  metadata: { displayName: 'Notes', summary: 'Keeps notes.', description: 'Keeps notes for a session.' },
} as unknown as PackageInstalledDescriptor

/** A ready backend whose uninstall is refused because sessions still pin the plugin's generation. */
function backend() {
  const calls: string[] = []
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/session')) return new Response('{}', { status: 200 })
    if (url.endsWith('/overview'))
      return Response.json({
        context: {
          profile: 'local-dev',
          clientId: 'uninstall-test',
          permissions: ['packages.read', 'packages.remove', 'packages.activate', 'packages.trust'],
          readOnly: false,
          authScope: 'auth.uninstall-test',
          features: Object.values(ADMIN_FEATURES),
        },
        inventory: { packages: [row] },
      })
    if (url.endsWith('/list')) return Response.json({ packages: [row] })
    if (url.endsWith('/tree/list')) return Response.json({ desiredDigest: 'sha256-x', actual: true })
    if (url.endsWith('/surfaces')) return Response.json({ surfaces: [] })
    if (url.endsWith('/pins/inspect')) return Response.json({ orphans: [] })
    if (url.endsWith('/remove')) {
      calls.push('remove')
      return Response.json({ operationId: 'remove-1', profile: 'local-dev' })
    }
    if (url.endsWith('/operation/get'))
      return Response.json({
        operationId: 'remove-1',
        profile: 'local-dev',
        operation: 'remove',
        packageId: ID,
        state: 'failed',
        progress: 100,
        startedAt: timestamp,
        updatedAt: timestamp,
        cancellable: false,
        retryable: true,
        error: {
          code: 'E_PACKAGE_BLOCKED',
          safeMessage: 'The package operation is blocked by active references or policy.',
          blockers: [{ code: 'generation', references: ['session:s-archived'] }],
        },
      } satisfies PackageOperation)
    return Response.json({ error: { code: 'UNEXPECTED', message: url } }, { status: 500 })
  })
  return { fetcher, calls }
}

let host: Awaited<ReturnType<typeof import('./web-dom-fixture.js').mountRenderedIndex>> | undefined
let root: Root | undefined
let current: PluginView | undefined

/** The plugins page's installed list and status line, over the real plugin controller. */
async function mountPlugins(fetcher: ReturnType<typeof backend>['fetcher']) {
  const { mountRenderedIndex } = await import('./web-dom-fixture.js')
  host = await mountRenderedIndex()
  document.documentElement.lang = 'en'
  history.replaceState(null, '', '/?page=plugins&tab=plugins#uninstall-token')
  vi.stubGlobal('fetch', fetcher)
  const web = await import('@agnes/web-ui')
  const { usePluginAdmin } = await import('../src/pages/plugins/admin-view.js')
  const { PluginStatus, PluginsTab } = await import('../src/pages/plugins/plugins-tab.js')
  const { pluginsPageCatalog } = await import('../src/pages/plugins/page-locale.js')
  const en = pluginsPageCatalog.en ?? {}
  const t = (key: string) => en[key] ?? key
  function Plugins() {
    const { host: controllerHost, view } = usePluginAdmin({})
    current = view
    const page = createElement(
      web.PushStack,
      { rootTitle: 'Plugins' },
      view && createElement(PluginStatus, { view, t, data: { openSettings() {} } as never }),
      view && createElement(PluginsTab, { view, t, summaries: {} }),
    )
    return createElement(
      'div',
      null,
      createElement('div', { ref: controllerHost, hidden: true }),
      view ? createElement(web.UiLocaleProvider, { source: view.locale }, page) : page,
    )
  }
  const container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root?.render(createElement(Plugins)))
  await vi.waitFor(() => expect(current?.state.installed).toHaveLength(1), { timeout: 5000 })
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  current = undefined
  await host?.dispose()
  host = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  history.replaceState(null, '', '/')
  document.documentElement.replaceChildren()
})

it('says why an uninstall was refused, naming what still uses the plugin', async () => {
  const { fetcher, calls } = backend()
  await mountPlugins(fetcher)
  const uninstall = current?.detailActions(row).find((action) => action.label === 'Uninstall plugin')
  expect(uninstall?.disabled).toBeFalsy()
  await act(async () => uninstall?.onClick())
  await vi.waitFor(() =>
    expect((document.getElementById('plugin-confirm') as HTMLDialogElement).open).toBe(true),
  )
  await act(async () => document.getElementById('plugin-confirm-action')?.click())
  await vi.waitFor(() => expect(calls).toEqual(['remove']))
  const notice = () => document.querySelector<HTMLElement>('[data-testid="plugin-notice"]')?.textContent
  await vi.waitFor(() => expect(notice()).toContain('session:s-archived'), { timeout: 5000 })
  expect(notice()).toBe(
    'Uninstall: Not completed: A session or another plugin still uses it, so it was not uninstalled. ' +
      'Why: Runtime generation blocks this operation: session:s-archived.',
  )
  // A package notice from the daemon rereads the inventory; the reason stays.
  await act(async () => window.dispatchEvent(new Event('agnes:plugins-invalidated')))
  await vi.waitFor(() => expect(current?.state.loading).toBe(false))
  expect(notice()).toContain('session:s-archived')
})
