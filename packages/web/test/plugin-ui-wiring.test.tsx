/** @vitest-environment happy-dom */
import type { PackageInstalledDescriptor } from '@agnes/protocol'
import type { ClientContext } from '@agnes/web-client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { pluginStates } from '../src/admin/plugins/control-panel.js'
import { startClientModules } from '../src/client-modules/boot.js'
import { createReconciler } from '../src/client-modules/reconcile.js'
import { LoopPicker, loadNewSessionCatalog, updateLoopPicker } from '../src/loop-picker.js'
import { enT } from './helpers/locale.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('loads exact new-session defaults and renders the selected/stale Loop accessibly', async () => {
  const loop = { id: 'workflow', version: '1.2.0', sourcePackage: '@acme/workflow', capabilities: ['resume'] }
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    Response.json(
      String(url).endsWith('/loops')
        ? { loops: [loop], revision: 3, defaults: { loop: { id: loop.id, version: loop.version } } }
        : { modelAdapters: [] },
    ),
  )
  const catalog = await loadNewSessionCatalog(fetcher)
  expect(catalog.defaults.loop).toEqual({ id: 'workflow', version: '1.2.0' })
  expect(fetcher.mock.calls[0]?.[0]).toBe('/admin/api/loops')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const view = {
    visible: true,
    disabled: false,
    loops: catalog.loops,
    ...(catalog.defaults.loop ? { selected: catalog.defaults.loop } : {}),
    label: enT('composer.loop.select'),
    inherited: enT('composer.loop.inherited'),
    unavailable: enT('composer.loop.unavailable'),
    onSelect: vi.fn(),
  }
  try {
    await act(async () => {
      updateLoopPicker(view)
      root.render(createElement(LoopPicker))
    })
    expect(host.textContent).toContain('workflow · 1.2.0')
    expect(host.querySelector('[role="combobox"]')?.getAttribute('aria-label')).toBe(view.label)
    await act(async () => updateLoopPicker({ ...view, loops: [] }))
    expect(host.querySelector('[role="status"]')?.textContent).toBe(view.unavailable)
    await expect(
      loadNewSessionCatalog(
        vi.fn(async () => Response.json({ loops: [{ id: 'bad' }], revision: 0, defaults: {} })),
      ),
    ).rejects.toThrow('invalid session catalog')
  } finally {
    await act(async () => {
      root.unmount()
      updateLoopPicker({ ...view, visible: false })
    })
    host.remove()
  }
})

it('mounts an installed UI package panel and reports a subsequent loader failure as failed', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const item = {
    id: '@acme/panel',
    version: '1.0.0',
    kinds: ['ui'],
    desired: 'enabled',
    actual: 'running',
  } as PackageInstalledDescriptor
  let runtime!: Awaited<ReturnType<typeof startClientModules>>
  await act(async () => {
    runtime = await startClientModules({
      agnes: { sessions: { get: () => undefined } } as never,
      panelContainer: host,
    })
  })
  let revision = 'v1'
  const reconciler = createReconciler({
    ctx: runtime.ctx,
    locale: runtime.locale,
    source: {
      list: async () => ({
        revision,
        statuses: [],
        modules: [
          {
            packageId: item.id,
            revision,
            entryUrl: `/plugins/panel/${revision}/index.js`,
            styleUrls: [],
            slots: ['workbench.panel'],
            extIds: [],
          },
        ],
      }),
    },
    importer: async () => {
      if (revision === 'v2') throw new Error('private loader details')
      return {
        apply(ctx: ClientContext) {
          ctx.slots.register('workbench.panel', () =>
            createElement('section', { 'aria-label': 'Community panel' }, 'Plugin panel content'),
          )
        },
      }
    },
  })
  try {
    await act(async () => reconciler.reconcileNow())
    await vi.waitFor(() => expect(host.textContent).toContain('Plugin panel content'))
    expect(pluginStates(item, reconciler.snapshot().get(item.id)).map((state) => state.key)).toContain(
      'active',
    )
    revision = 'v2'
    await act(async () => reconciler.invalidate())
    const failure = reconciler.snapshot().get(item.id)
    expect(failure).toMatchObject({ phase: 'failed', error: { code: 'CLIENT_MODULE_IMPORT_FAILED' } })
    expect(failure?.error?.message).not.toContain('private')
    expect(pluginStates(item, failure).map((state) => state.key)).toContain('failed')
  } finally {
    await act(async () => runtime.dispose())
    host.remove()
  }
})
