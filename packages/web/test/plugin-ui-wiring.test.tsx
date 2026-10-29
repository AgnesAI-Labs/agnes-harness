/** @vitest-environment happy-dom */
import { defaultLoop, type PackageInstalledDescriptor } from '@agnes/protocol'
import { pluginStates } from '@agnes/web-admin/admin/plugins/control-panel'
import * as businessAgents from '@agnes/web-admin/agents'
import { AGENTS_NAMESPACE, agentsCatalog, businessAgentView } from '@agnes/web-admin/agents'
import { type ClientContext, homeNavigation } from '@agnes/web-client'
import { LOCALE_STORAGE_KEY } from '@agnes/web-foundation/locale-preference'
import { THEME_STORAGE_KEY } from '@agnes/web-foundation/theme'
import { useUiText } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { startClientModules } from '../src/client-modules/boot.js'
import { createReconciler } from '../src/client-modules/reconcile.js'
import { LoopPicker, loadNewSessionCatalog, updateLoopPicker } from '../src/loop-picker.js'
import { bundledPresentation } from './helpers/bundled-presentation.js'
import { enT } from './helpers/locale.js'
import { expectLocalizedDom } from './helpers/localized-dom.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('loads exact new-session defaults and renders the selected/stale Loop accessibly', async () => {
  const loop = { id: 'workflow', version: '1.2.0', sourcePackage: '@acme/workflow', capabilities: ['resume'] }
  let release: () => void = () => {}
  const allRequested = new Promise<void>((resolve) => {
    release = resolve
  })
  const requested = new Set<string>()
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    requested.add(String(url))
    if (requested.size === 3) release()
    // Independent catalog reads must start before any of their responses are available.
    await allRequested
    return Response.json(
      String(url).endsWith('/loops')
        ? {
            loops: [loop],
            revision: 3,
            defaults: { providers: { loop: { provider: loop.id, version: loop.version } } },
          }
        : { modelAdapters: [] },
    )
  })
  const catalog = await loadNewSessionCatalog(fetcher)
  expect(defaultLoop(catalog.defaults)).toEqual({ id: 'workflow', version: '1.2.0' })
  expect(fetcher.mock.calls[0]?.[0]).toBe('/admin/api/loops')
  const essentials = await loadNewSessionCatalog(async (url) => {
    if (String(url).endsWith('/composition')) return new Promise<Response>(() => {})
    return fetcher(url)
  }, false)
  expect(essentials.loops).toEqual(catalog.loops)
  expect(essentials.composition).toBeUndefined()
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
  const row = (bundle: string, title: { en: string; 'zh-CN': string }) =>
    ({
      id: 'acme/kit',
      agents: [{ ref: `acme/kit#${bundle}`, launch: { title, description: { en: 'Does the work' } } }],
    }) as never
  const previousLanguage = document.documentElement.lang
  const source = vi.spyOn(businessAgents, 'useBusinessAgents').mockImplementation(() => {
    // The locale the picker's data hook sees is the one a real caller gets from the application tree.
    const { locale } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
    return {
      agents: [
        businessAgentView(row('second', { en: 'Second agent', 'zh-CN': '第二个智能体' }), locale),
        businessAgentView(row('unavailable', { en: 'Unavailable agent', 'zh-CN': '不可用智能体' }), locale),
      ],
      readyAgents: ['acme/kit#second'],
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
    }
  })
  const host = document.createElement('div')
  document.body.append(host)
  let runtime!: Awaited<ReturnType<typeof startClientModules>>
  try {
    // The composer region mounts under the application root, as in the product.
    const conversationUi = await bundledPresentation('conversation')
    const { clientModule } = await import('@agnes/web-client')
    await act(async () => {
      runtime = await startClientModules({
        agnes: { sessions: { get: () => undefined } } as never,
        composerContainer: host,
      })
      await runtime.ctx.plugin(clientModule(conversationUi), {
        packageId: '@agnes/conversation-ui',
        revision: 'agents-locale',
        clientId: 'conversation-ui',
        presentationRoles: ['conversation', 'composer'],
        slotCatalogVersion: 'dsh-client-slots/v1',
        binding: { owner: 'agents-locale', lifetime: 'profile', availability: 'active' },
      } as never)
    })
    localStorage.setItem('agnes.settings.advanced', '0')
    await act(async () => {
      updateLoopPicker({
        visible: true,
        disabled: true,
        loops: [],
        label: 'Loop',
        inherited: '',
        unavailable: '',
        onSelect() {},
      })
    })
    expect(source).toHaveBeenLastCalledWith({}, { enabled: false })
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
    })
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="composer-agent"]')!
    expect(trigger.hidden).toBe(false)
    expect(source).toHaveBeenLastCalledWith({}, { enabled: true })
    await act(async () => trigger.click())
    const picker = document.querySelector('[data-testid="new-session-agent"]')!
    await act(async () =>
      picker.querySelector('input')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    )
    const choices = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')]
    expect(choices.map((choice) => choice.textContent)).toEqual(['Second agent'])
    // The user's language reaches the picker through the real locale event, not a hand-set attribute.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('agnes:locale-changed', { detail: 'zh-CN' }))
    })
    expect(document.documentElement.lang).toBe('zh-CN')
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].map((c) => c.textContent),
      ).toEqual(['第二个智能体']),
    )
    await act(async () => document.querySelector<HTMLElement>('.ant-select-item-option')!.click())
    expect(homeNavigation.getSnapshot()).toEqual({
      id: 'agents',
      selection: { focus: 'acme/kit', agent: 'acme/kit#second', start: true },
    })
    await act(async () =>
      updateLoopPicker({
        visible: false,
        disabled: true,
        loops: [],
        label: 'Loop',
        inherited: '',
        unavailable: '',
        onSelect() {},
      }),
    )
    expect(source).toHaveBeenLastCalledWith({}, { enabled: false })
  } finally {
    source.mockRestore()
    localStorage.removeItem('agnes.settings.advanced')
    homeNavigation.close()
    await act(async () => {
      await runtime?.dispose()
    })
    document.documentElement.lang = previousLanguage
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

it.each(['en', 'zh-CN'] as const)(
  'localizes shipped composer model settings and live locale changes (%s)',
  async (language) => {
    const conversationUi = await bundledPresentation('conversation')
    const { clientModule } = await import('@agnes/web-client')
    const { webUiLocaleCatalog } = await import('@agnes/web-ui')
    const host = document.body.appendChild(document.createElement('section'))
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}, { status: 403 }))
    let runtime!: Awaited<ReturnType<typeof startClientModules>>
    let fiber: ReturnType<typeof runtime.ctx.plugin> | undefined
    const previousLanguage = document.documentElement.lang
    const longModel = `deepseek-${'long-model-name-'.repeat(10)}`
    try {
      await act(async () => {
        runtime = await startClientModules({
          agnes: { sessions: { get: () => undefined } } as never,
          composerContainer: host,
          composer: {
            onCancel() {},
            onDraftChange() {},
            onError() {},
            onSubmit() {},
            onWorkspace() {},
            onModelSelect: async () => true,
            onPermissionSelect: async () => true,
            onModelSettingsChange: async () => true,
            onAuxiliaryRead: async () => ({
              fast: { route: 'deepseek', model: longModel },
              defaults: { fast: { route: 'deepseek', model: 'deepseek-v4-pro' }, verifier: null },
            }),
            onAuxiliarySelect: async () => true,
          },
        })
        fiber = runtime.ctx.plugin(clientModule(conversationUi), {
          packageId: '@agnes/conversation-ui',
          revision: 'locale-test',
          clientId: 'conversation-ui',
          presentationRoles: ['conversation', 'composer'],
          slotCatalogVersion: 'dsh-client-slots/v1',
          binding: { owner: 'locale-test', lifetime: 'profile', availability: 'active' },
        } as never)
        await fiber
        runtime.composer?.render({
          cancel: { disabled: true, hidden: true, label: 'Stop' },
          connected: true,
          configured: true,
          hasSession: true,
          loading: false,
          hint: { kind: 'shortcut', text: 'Enter' },
          input: { disabled: false, placeholder: 'Task' },
          permission: { disabled: false, pending: false, selected: 'workspace' },
          sending: false,
          stopping: false,
          usage: undefined,
          send: { disabled: false, label: 'Send', mode: 'idle', title: 'Send' },
          workspace: { disabled: false, label: 'workspace', title: 'workspace' },
          model: {
            accessibleName: 'DeepSeek',
            label: 'deepseek-v4-pro',
            options: [{ route: 'deepseek', id: 'deepseek-v4-pro', label: 'DeepSeek' }],
            selected: { route: 'deepseek', id: 'deepseek-v4-pro' },
            disabled: false,
            pending: false,
            auxiliaryAvailable: true,
          },
          modelSettings: {
            settings: {},
            contextWindow: 128000,
            thinkingLevelMap: { low: 'low', high: 'high' },
          },
        })
      })
      await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('#model')?.disabled).toBe(false))
      await act(async () => host.querySelector<HTMLButtonElement>('#model')!.click())
      await vi.waitFor(() => expect(document.querySelector('#model-picker-popover')).toBeTruthy())
      for (const current of [language, language === 'en' ? 'zh-CN' : 'en'] as const) {
        await act(async () => {
          document.documentElement.lang = current
          runtime.locale.setLocale(current)
        })
        const panel = document.querySelector<HTMLElement>('#model-picker-popover')!
        await vi.waitFor(() =>
          expect(panel.querySelector('.model-picker-session .model-picker-group-title')?.textContent).toBe(
            runtime.locale.t('modelSettings.session'),
          ),
        )
        expectLocalizedDom(panel)
        // Check every shared model-settings message as well as the rendered branches below.
        for (const [key, text] of Object.entries(webUiLocaleCatalog[current]).filter(([key]) =>
          key.startsWith('modelSettings.'),
        ))
          expect(runtime.locale.t(key)).toBe(text)
        const row = panel.querySelector<HTMLButtonElement>('#model-picker-auxiliary')!
        // The row summarises the slots; the long model name is read in the sub-panel.
        await vi.waitFor(() =>
          expect(row.querySelector('.model-picker-value')?.textContent).toBe(
            runtime.locale.t('modelSettings.slots.changed', { count: 1 }),
          ),
        )
        expect(row.textContent).not.toContain(longModel)
        for (const kind of ['thinking', 'context', 'auxiliary']) {
          await act(async () => panel.querySelector<HTMLButtonElement>(`#model-picker-${kind}`)!.click())
          expectLocalizedDom(panel)
          if (kind === 'context') {
            await act(async () =>
              [...panel.querySelectorAll<HTMLButtonElement>('#session-model-budget button')]
                .find((button) => button.textContent === runtime.locale.t('modelSettings.custom'))!
                .click(),
            )
            expectLocalizedDom(panel)
          }
          await act(async () => panel.querySelector<HTMLButtonElement>('.model-picker-back')!.click())
        }
      }
      await act(async () => document.body.click())
    } finally {
      await act(async () => {
        await fiber?.dispose()
        await runtime?.dispose()
      })
      document.documentElement.lang = previousLanguage
      host.remove()
      fetcher.mockRestore()
    }
  },
)

it('switches the bundled conversation to an IDE and back, reclaiming partial mounts and preserving host work', async () => {
  const { apply } = await bundledPresentation('conversation')
  const { presentationRoles, clientModule, conversationCards } = await import('@agnes/web-client')
  const conversation = document.createElement('section')
  const composer = document.createElement('section')
  const previousLanguage = document.documentElement.lang
  const originalBlobURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:preview' })
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
    for (const language of ['en', 'zh-CN']) {
      await act(async () => {
        document.documentElement.lang = language
        runtime.locale.setLocale(language)
        runtime.transcript?.render([
          { kind: 'user', id: 'question', seq: 1, content: [{ type: 'text', text: 'Question' }] },
          { kind: 'assistant', id: 'answer', seq: 2, text: 'Answer' },
        ])
      })
      await vi.waitFor(() => expect(conversation.textContent).toContain('Answer'))
      expectLocalizedDom(conversation)
    }
    runtime.composer?.setDraft('Keep this draft')
    const composerInput = composer.querySelector('textarea')
    const { createRegionRenderer } = await import('@agnes/web-ui')
    await act(async () => {
      runtime.session.setSession('background')
    })
    const attachment = { type: 'file' as const, data: 'aGVsbG8=', mimeType: 'text/plain', name: 'draft.txt' }
    const image = {
      type: 'image' as const,
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      mimeType: 'image/png',
    }
    await act(async () => {
      runtime.composer?.restoreAttachmentBlocks([attachment, image])
    })
    const attachments = runtime.composer?.getAttachmentBlocks()
    const images = runtime.composer?.getImageBlocks()
    expect(attachments).toHaveLength(2)
    expect(images).toHaveLength(1)
    const sessionNotifications = vi.fn()
    runtime.registry.subscribeSession(sessionNotifications)
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
    expect(runtime.composer?.getAttachmentBlocks()).toEqual(attachments)
    expect(runtime.composer?.getImageBlocks()).toEqual(images)
    expect(sessionNotifications).not.toHaveBeenCalled()
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
    document.documentElement.lang = previousLanguage
    composer.remove()
    if (originalBlobURL) Object.defineProperty(URL, 'createObjectURL', originalBlobURL)
    else Reflect.deleteProperty(URL, 'createObjectURL')
    fetcher.mockRestore()
  }
})

it('mounts the release navigation through its public port and retains mobile focus and skin hooks', async () => {
  const { apply } = await bundledPresentation('navigation')
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
    for (const language of ['en', 'zh-CN']) {
      await act(async () => runtime.locale.setLocale(language))
      expectLocalizedDom(aside)
    }
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

it('preserves host composer files and images across same-session reconnects during a renderer gap', async () => {
  const { startClientModules } = await import('../src/client-modules/boot.js')
  const { PresentationService } = await import('@agnes/web-client')
  const container = document.createElement('section')
  document.body.append(container)
  let runtime!: Awaited<ReturnType<typeof startClientModules>>
  await act(async () => {
    runtime = await startClientModules({
      agnes: { sessions: { get: (id: string) => ({ id, listeners: new Set() }) } } as never,
      composerContainer: container,
    })
  })
  const port = (runtime.ctx.get('presentation') as InstanceType<typeof PresentationService>).host.composer!
  let images: Parameters<NonNullable<typeof runtime.composer>['restoreImageBlocks']>[0] = []
  let files: Parameters<NonNullable<typeof runtime.composer>['restoreAttachmentBlocks']>[0] = []
  let references: ReturnType<NonNullable<typeof runtime.composer>['getDraftReferences']> = { files: [], skills: [] }
  const handle = {
    getDraft: () => 'retained draft',
    getDraftReferences: () => references,
    getImageBlocks: () => images,
    getAttachmentBlocks: () => files,
    hasPendingImages: () => false,
    focus() {},
    render() {},
    setDraft() {},
    mention() {},
    dispose() {},
    clearImageBlocks() {
      images = []
      files = []
    },
    restoreImageBlocks(value: typeof images) {
      images = value
    },
    restoreAttachmentBlocks(value: typeof files) {
      files = value
    },
    restoreDraftReferences(value: typeof references) {
      references = value
    },
  }
  try {
    runtime.session.setSession('same')
    const detach = port.attach(handle)
    const attachment = { type: 'file' as const, data: 'aGVsbG8=', mimeType: 'text/plain', name: 'draft.txt' }
    const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }
    runtime.composer!.restoreAttachmentBlocks([attachment])
    runtime.composer!.restoreImageBlocks([image])
    detach()
    runtime.session.setReadiness('connecting', 'same')
    runtime.session.reattach('same')
    expect(runtime.composer!.getDraft()).toBe('retained draft')
    expect(runtime.composer!.getAttachmentBlocks()).toEqual([attachment])
    expect(runtime.composer!.getImageBlocks()).toEqual([image])
    runtime.session.setSession('different')
    expect(runtime.composer!.getAttachmentBlocks()).toEqual([])
    expect(runtime.composer!.getImageBlocks()).toEqual([])
  } finally {
    await act(async () => {
      await runtime.dispose()
    })
    container.remove()
  }
})

it.each(['system', 'theme-storage', 'theme-event', 'locale-storage', 'locale-event'])(
  'retires %s preference updates with the client runtime and supports remounting',
  async (source) => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    let dark = false
    const matches = vi.spyOn(media, 'matches', 'get').mockImplementation(() => dark)
    const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue(media)
    const runtimes: Awaited<ReturnType<typeof startClientModules>>[] = []
    const language = document.documentElement.lang
    const isLocale = source.startsWith('locale')
    const reset = () => {
      dark = false
      localStorage.setItem(THEME_STORAGE_KEY, source === 'system' ? 'system' : 'light')
      localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
    }
    const change = (enabled = true) => {
      dark = enabled
      if (source !== 'system') localStorage.setItem(THEME_STORAGE_KEY, enabled ? 'dark' : 'light')
      localStorage.setItem(LOCALE_STORAGE_KEY, enabled ? 'zh-CN' : 'en')
      if (source === 'system') media.dispatchEvent(new Event('change'))
      else if (source.endsWith('storage'))
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: isLocale ? LOCALE_STORAGE_KEY : THEME_STORAGE_KEY,
          }),
        )
      else
        window.dispatchEvent(
          new CustomEvent(`agnes:${isLocale ? 'locale' : 'theme'}-changed`, {
            detail: enabled ? 'zh-CN' : 'en',
          }),
        )
    }
    const start = async () => {
      const runtime = await startClientModules({ agnes: { sessions: { get: () => undefined } } as never })
      runtimes.push(runtime)
      return runtime
    }
    const snapshot = (runtime: (typeof runtimes)[number]) => [
      runtime.theme.getSnapshot(),
      runtime.locale.locale,
    ]
    const initial = ['light', 'en']
    const changed = isLocale ? ['light', 'zh-CN'] : ['dark', 'en']
    try {
      reset()
      const old = await start()
      expect(snapshot(old)).toEqual(initial)
      change()
      expect(snapshot(old)).toEqual(changed)
      expect(document.documentElement.lang).toBe(isLocale ? 'zh-CN' : 'en')
      change(false)
      expect(snapshot(old)).toEqual(initial)
      await old.dispose()
      await old.dispose()
      change()
      expect(snapshot(old)).toEqual(initial)
      expect(document.documentElement.lang).toBe('en')
      reset()
      const next = await start()
      expect(snapshot(next)).toEqual(initial)
      change()
      expect(snapshot(old)).toEqual(initial)
      expect(snapshot(next)).toEqual(changed)
      change(false)
      expect(snapshot(next)).toEqual(initial)
      await next.dispose()
      await next.dispose()
      change()
      expect(snapshot(next)).toEqual(initial)
      expect(document.documentElement.lang).toBe('en')
    } finally {
      for (const runtime of runtimes) await runtime.dispose()
      matches.mockRestore()
      matchMedia.mockRestore()
      localStorage.clear()
      document.documentElement.lang = language
    }
  },
)
