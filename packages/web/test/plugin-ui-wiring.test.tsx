/** @vitest-environment happy-dom */
import { defaultLoop, type PackageInstalledDescriptor } from '@agnes/protocol'
import { pluginStates } from '@agnes/web-admin/admin/plugins/control-panel'
import * as businessAgents from '@agnes/web-admin/agents'
import { type ClientContext, homeNavigation } from '@agnes/web-client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
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
        ? {
            loops: [loop],
            revision: 3,
            defaults: { providers: { loop: { provider: loop.id, version: loop.version } } },
          }
        : { modelAdapters: [] },
    ),
  )
  const catalog = await loadNewSessionCatalog(fetcher)
  expect(defaultLoop(catalog.defaults)).toEqual({ id: 'workflow', version: '1.2.0' })
  expect(fetcher.mock.calls[0]?.[0]).toBe('/admin/api/loops')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const chosen = defaultLoop(catalog.defaults)
  const view = {
    visible: true,
    disabled: false,
    loops: catalog.loops,
    ...(chosen ? { selected: chosen } : {}),
    label: enT('composer.loop.select'),
    inherited: enT('composer.loop.inherited'),
    unavailable: enT('composer.loop.unavailable'),
    onSelect: vi.fn(),
  }
  // Advanced settings show unless this browser turned them off.
  localStorage.setItem('agnes.settings.advanced', '0')
  try {
    await act(async () => {
      updateLoopPicker(view)
      root.render(createElement(LoopPicker))
    })
    expect(host.textContent).toContain('workflow')
    expect(host.querySelector('[role="combobox"]')).toBeNull()
    expect(host.querySelector<HTMLButtonElement>('[data-testid="composer-agent"]')?.hidden).toBe(true)
    await act(async () =>
      updateLoopPicker({ ...view, bundles: [{ id: 'workflow#delivery', sourcePackage: 'workflow' }] }),
    )
    // One loop and nothing chosen: the chip has nothing to select until advanced settings show.
    expect(host.querySelector<HTMLButtonElement>('[data-testid="composer-agent"]')?.hidden).toBe(true)
    localStorage.removeItem('agnes.settings.advanced')
    await act(async () =>
      updateLoopPicker({ ...view, bundles: [{ id: 'workflow#delivery', sourcePackage: 'workflow' }] }),
    )
    expect(host.querySelector<HTMLButtonElement>('[data-testid="composer-agent"]')?.hidden).toBe(false)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="composer-agent"]')?.click())
    expect(document.querySelector('[data-testid="new-session-loop-readonly"]')?.textContent).toContain(
      'workflow',
    )
    await act(async () => updateLoopPicker({ ...view, loops: [] }))
    expect(document.querySelector('[role="status"]')?.textContent).toBe(view.unavailable)
    await expect(
      loadNewSessionCatalog(
        vi.fn(async () => Response.json({ loops: [{ id: 'bad' }], revision: 0, defaults: {} })),
      ),
    ).rejects.toThrow('invalid session catalog')
  } finally {
    localStorage.removeItem('agnes.settings.advanced')
    await act(async () => {
      root.unmount()
      updateLoopPicker({ ...view, visible: false })
    })
    host.remove()
  }
})

it('offers backend-ready AgentRefs in a new draft and opens the exact agent review', async () => {
  const agent = {
    ref: 'acme/kit#second',
    entry: { id: 'acme/kit' },
    name: 'Second agent',
  } as businessAgents.BusinessAgent
  const source = vi.spyOn(businessAgents, 'useBusinessAgents').mockReturnValue({
    agents: [agent, { ...agent, ref: 'acme/kit#unavailable', name: 'Unavailable agent' }],
    readyAgents: [agent.ref],
    catalogError: undefined,
    api: undefined,
    features: undefined,
    installed: [],
    denied: undefined,
    busy: false,
    failed: false,
    error: undefined,
    loaded: true,
    reload() {},
    refreshInstalled() {},
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    localStorage.setItem('agnes.settings.advanced', '0')
    await act(async () => {
      updateLoopPicker({
        visible: true,
        disabled: false,
        loops: [],
        label: 'Loop',
        inherited: '',
        unavailable: '',
        onSelect() {},
      })
      root.render(createElement(LoopPicker))
    })
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="composer-agent"]')!
    expect(trigger.hidden).toBe(false)
    await act(async () => trigger.click())
    const picker = document.querySelector('[data-testid="new-session-agent"]')!
    await act(async () =>
      picker.querySelector('input')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    )
    const choices = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')]
    expect(choices.map((choice) => choice.textContent)).toEqual(['Second agent'])
    await act(async () => choices[0]!.click())
    expect(homeNavigation.getSnapshot()).toEqual({
      id: 'agents',
      selection: { focus: 'acme/kit', agent: agent.ref, start: true },
    })
  } finally {
    source.mockRestore()
    localStorage.removeItem('agnes.settings.advanced')
    homeNavigation.close()
    await act(async () => root.unmount())
    host.remove()
  }
})

it('mounts an installed UI package panel and reports a subsequent loader failure as failed', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const item = {
    id: '@acme/panel',
    version: '1.0.0',
    provides: ['ui'],
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
    expect(pluginStates(item, reconciler.snapshot().get(item.id))).toEqual([])
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

it('switches the bundled conversation to an IDE and back, reclaiming partial mounts and preserving host work', async () => {
  const { apply } = await import('../src/presentations/conversation.js')
  const { presentationRoles, clientModule, conversationCards } = await import('@agnes/web-client')
  const conversation = document.createElement('section')
  const composer = document.createElement('section')
  const cancel = vi.fn()
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}, { status: 403 }))
  document.body.append(conversation, composer)
  let runtime!: Awaited<ReturnType<typeof startClientModules>>
  await act(async () => {
    runtime = await startClientModules({
      agnes: { sessions: { get: (id: string) => ({ id, listeners: new Set(), cancel }) } } as never,
      conversationContainer: conversation,
      composerContainer: composer,
    })
  })
  const identity = (packageId: string) => ({
    packageId,
    revision: 'one',
    clientId: 'ui',
    slotCatalogVersion: 'dsh-client-slots/v1',
    presentationRoles: ['conversation', 'composer'],
    binding: { owner: packageId, lifetime: 'profile', availability: 'active' },
  })
  let builtin: ReturnType<typeof runtime.ctx.plugin> | undefined
  let custom: ReturnType<typeof runtime.ctx.plugin> | undefined
  try {
    await act(async () => {
      builtin = runtime.ctx.plugin(clientModule({ apply }), identity('@agnes/conversation-ui') as never)
      await builtin
    })
    await vi.waitFor(() => expect(conversation.querySelector('#transcript')).toBeTruthy())
    runtime.composer?.setDraft('Keep this draft')
    const composerInput = composer.querySelector('textarea')
    const { createRegionRenderer } = await import('@agnes/web-ui')
    await act(async () => {
      runtime.session.setSession('background')
    })
    let renders = 0
    await act(async () => {
      custom = runtime.ctx.plugin(
        clientModule({
          apply(ctx) {
            ctx.presentationRoles.register({
              role: 'conversation',
              mount(child) {
                child.conversationCards.register({
                  id: 'ide-card',
                  order: 0,
                  matches: () => false,
                  component: () => null,
                })
                const root = createRegionRenderer(child.presentation.conversation!.container)
                root.render(
                  createElement('section', { 'aria-label': 'IDE conversation' }, `IDE ${++renders}`),
                )
                return () => root.unmount()
              },
            })
          },
        }),
        identity('acme/ide') as never,
      )
      await custom
      presentationRoles.select({ conversation: { packageId: 'acme/ide', clientId: 'ui' } })
    })
    await vi.waitFor(() => expect(conversation.textContent).toContain('IDE'))
    expect(conversationCards.get('ide-card')).toBeDefined()
    expect(runtime.composer?.getDraft()).toBe('Keep this draft')
    expect(composer.querySelector('textarea')).toBe(composerInput)
    await act(async () => {
      presentationRoles.select()
    })
    await vi.waitFor(() => expect(conversation.querySelector('#transcript')).toBeTruthy())
    expect(conversationCards.get('ide-card')).toBeUndefined()
    expect(runtime.session.sessionId).toBe('background')
    expect(cancel).not.toHaveBeenCalled()
  } finally {
    await act(async () => {
      presentationRoles.select()
      await custom?.dispose()
      await builtin?.dispose()
      await runtime.dispose()
    })
    conversation.remove()
    composer.remove()
    fetcher.mockRestore()
  }
})

it('mounts the release navigation through its public port and retains mobile focus and skin hooks', async () => {
  const { apply } = await import('../src/presentations/navigation.js')
  const { clientModule } = await import('@agnes/web-client')
  const aside = document.createElement('aside')
  aside.className = 'sidebar'
  aside.setAttribute('data-agnes-region', 'sidebar')
  const header = document.createElement('header')
  const backdrop = document.createElement('button')
  backdrop.id = 'sidebar-backdrop'
  document.body.append(aside, header, backdrop)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}, { status: 403 }))
  let runtime!: Awaited<ReturnType<typeof startClientModules>>
  let fiber: ReturnType<typeof runtime.ctx.plugin> | undefined
  try {
    await act(async () => {
      runtime = await startClientModules({
        agnes: { sessions: { get: () => undefined } } as never,
        sidebarContainer: aside,
        topbarContainer: header,
      })
    })
    await act(async () => {
      fiber = runtime.ctx.plugin(clientModule({ apply }), {
        packageId: '@agnes/navigation-ui',
        revision: 'one',
        clientId: 'navigation-ui',
        presentationRoles: ['navigation'],
        slotCatalogVersion: 'dsh-client-slots/v1',
        binding: { owner: 'release-navigation', lifetime: 'profile', availability: 'active' },
      } as never)
      await fiber
    })
    await vi.waitFor(() => expect(aside.querySelector('#new')).toBeTruthy())
    const { EMPTY_SIDEBAR_STATE } = await import('@agnes/web-units/shell')
    await act(async () => {
      runtime.sidebar?.update({ ...EMPTY_SIDEBAR_STATE, newDisabled: false })
    })
    runtime.sidebar?.focusNew()
    expect(document.activeElement?.id).toBe('new')
    expect(aside.getAttribute('data-agnes-region')).toBe('sidebar')
    expect(aside.querySelector('nav')?.getAttribute('aria-label')).toBeTruthy()
    await act(async () => {
      await fiber?.dispose()
    })
    expect(aside.querySelector('#new')).toBeNull()
  } finally {
    await act(async () => {
      await runtime?.dispose()
    })
    aside.remove()
    header.remove()
    backdrop.remove()
    fetcher.mockRestore()
  }
})
