/** @vitest-environment happy-dom */
import type { AgentPlan, ApplicationState } from '@agnes/protocol'
import { applicationIdentity, homeEntries, homeNavigation, openComposerLaunch } from '@agnes/web-client'
import { clearResources, createDocumentLocaleSource, UiLocaleProvider } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentsPage } from '../src/pages/agents-page.js'
import { activeHomeEntry, HomePageHost, watchActiveHomeEntry } from '../src/pages/host.js'
import { HomeEntriesNav } from '../src/regions/home-entries.js'

const mock = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('../src/pages/admin-api.js', () => ({ homeAdmin: mock.connect }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => {
  clearResources()
  applicationIdentity.set(undefined)
  vi.restoreAllMocks()
  document.body.replaceChildren()
  history.replaceState(null, '', '/')
})

it.each(['success', 'recover', 'unknown', 'wrong-ref', 'cancel', 'enable', 'inherited', 'covered'] as const)(
  'lists explicit agents, starts the plain Loop and uses a reviewed AgentRef ticket (%s)',
  async (outcome) => {
    const loops = [
      { id: 'acme.workflow', version: '1.0.0', label: 'Workflow', sourcePackage: 'acme/kit' },
      { id: 'acme.chat', version: '2.0.0', label: 'Chat', sourcePackage: '@agnes/loop-default' },
    ]
    const plan: AgentPlan = {
      ref: 'acme/kit#reply',
      launch: {
        title: { en: 'Reviewed reply' },
        description: { en: 'Reviewed description' },
        preset: 'reviewed',
        prompt: { mode: 'draft', text: { en: 'Backend editable draft' } },
      },
      loop: { id: 'borrowed.loop', version: '3.0.0' },
      bundles: ['acme/kit#reply', 'shared/tools#base'],
      preset: 'reviewed',
      pages: [],
      digest: 'digest',
      compositionHash: 'composition',
      presetHash: 'preset',
      effectivePresetHash: 'effective',
      model: { route: 'default', model: 'reviewed-model' },
      models: { main: { route: 'default', model: 'reviewed-model' } },
      permission: { readOnly: true, tools: ['shared.tool'], allow: [], deny: [] },
      sources: [{ id: 'shared/tools', version: '2.0.0', integrity: 'sha512-reviewed', source: 'local' }],
    }
    let finishPrepare: (() => void) | undefined
    const resolveAgent = vi.fn(async () => {
      throw new Error('must not probe launch readiness')
    })
    const prepareAgent = vi.fn(async (_ref: string) => {
      if (outcome === 'cancel')
        await new Promise<void>((resolve) => {
          finishPrepare = resolve
        })
      return {
        launchTicket: 'reviewed-ticket',
        ...(outcome === 'covered' ? { consent: 'covered' as const } : {}),
        presentation: outcome === 'wrong-ref' ? { ...plan, ref: 'acme/kit#triage' } : plan,
      }
    })
    const result = { sessionId: 'session-reviewed', draft: plan.launch.prompt }
    const startAgent = vi.fn(async (_ticket: string, _operationId: string) => {
      if (outcome !== 'success' && outcome !== 'enable') throw new Error('lost response')
      return result
    })
    const readAgent = vi
      .fn()
      .mockResolvedValue(
        outcome === 'unknown'
          ? { state: 'unknown', code: 'OUTCOME_UNKNOWN', cause: 'LOOP_MISSING' }
          : { state: 'completed', ...result },
      )
    let enabled = outcome !== 'enable'
    const declarations = ['triage', 'reply'].map((id) => ({
      ref: `acme/kit#${id}`,
      launch: { title: { en: id }, description: { en: `${id} description` }, preset: 'safe' },
    }))
    mock.connect.mockResolvedValue({
      context: {
        permissions: outcome === 'enable' ? ['packages.install', 'packages.trust', 'packages.activate'] : [],
        readOnly: false,
      },
      api: {
        resolveAgent,
        prepareAgent,
        startAgent,
        readAgent,
        catalog: async () => {
          if (outcome !== 'enable') throw new Error('offline catalog')
          return {
            items: [
              {
                id: 'acme/kit',
                version: '1.0.0',
                source: { type: 'file', ref: 'file:./kit' },
                integrity: 'sha512-kit',
                license: 'Apache-2.0',
                sourceId: 'test-catalog',
                retrievedAt: '2026-10-18T00:00:00Z',
                compatibility: 'supported',
                contributions: [],
                agents: declarations,
              },
            ],
          }
        },
        enable: async () => {
          enabled = true
          return { operationId: 'enable-kit' }
        },
        operation: async () => ({ state: 'completed' }),
        loops: async () => ({
          loops,
          revision: 1,
          defaults:
            outcome === 'inherited'
              ? {}
              : { providers: { loop: { provider: 'acme.chat', version: '2.0.0' } } },
        }),
        runtime: async () => ({
          bundles: [
            { id: 'acme/kit#triage', sourcePackage: 'acme/kit' },
            { id: 'acme/kit#reply', sourcePackage: 'acme/kit' },
          ],
        }),
        list: async () => ({
          packages: [
            {
              id: 'acme/kit',
              version: '1.0.0',
              source: { type: 'file', ref: 'file:./kit' },
              contributions: [],
              trusted: true,
              desired: enabled ? 'enabled' : 'installed-disabled',
              actual: enabled ? 'running' : 'not-running',
              integrity: 'sha512-kit',
              blockers: [],
              primaryStatus: {
                state: 'ready',
                reason: { en: 'Backend confirmed', 'zh-CN': '后台已确认' },
                nextAction: 'none',
              },
              agents: declarations,
            },
          ],
        }),
      },
    })
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const assign = vi.spyOn(location, 'assign').mockImplementation(() => {})
    const opened: unknown[] = []
    const onOpen = (event: Event) => opened.push((event as CustomEvent).detail)
    window.addEventListener('agnes:open-session', onOpen)
    try {
      await act(async () => root.render(createElement(AgentsPage, { context: { t: (key) => key } })))
      await vi.waitFor(() => expect(host.querySelectorAll('[data-agent-ref]')).toHaveLength(2))
      expect(host.querySelectorAll('[data-testid="plugin-primary-status"][data-state="ready"]')).toHaveLength(
        2,
      )
      expect(host.textContent).toContain('triage description')
      expect(host.textContent).toContain('acme/kit')
      expect(resolveAgent).not.toHaveBeenCalled()
      expect(prepareAgent).not.toHaveBeenCalled()
      const general = host.querySelector('[data-testid="general-agent"]')
      await vi.waitFor(() =>
        expect(general?.querySelector('button:not([aria-haspopup])')?.hasAttribute('disabled')).toBe(false),
      )
      const initialStart = [...(general?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === 'Start conversation',
      )
      await act(async () => initialStart?.click())
      expect(assign).toHaveBeenCalledWith(
        outcome === 'inherited' ? '/?new=1&loop=acme.workflow%401.0.0' : '/?new=1&loop=acme.chat%402.0.0',
      )
      assign.mockClear()
      await act(async () => general?.querySelector<HTMLElement>('.agh-disclosure-summary')?.click())
      // The picker is a native public Select: keyboard choice selects the requested provider.
      await act(async () =>
        general?.querySelector('input')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
      )
      const option = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
        (item) => item.textContent === (outcome === 'inherited' ? 'Chat' : 'Workflow'),
      )
      await act(async () => option?.click())
      const start = [...(general?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === 'Start conversation',
      )
      await act(async () => start?.click())
      expect(assign).toHaveBeenCalledWith(
        outcome === 'inherited' ? '/?new=1&loop=acme.chat%402.0.0' : '/?new=1&loop=acme.workflow%401.0.0',
      )
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-agent-ref="acme/kit#reply"] button')?.click(),
      )
      await vi.waitFor(() => expect(prepareAgent).toHaveBeenCalledWith('acme/kit#reply'))
      if (outcome === 'cancel') {
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[data-testid="agent-launch-close"]')?.click(),
        )
        await act(async () => finishPrepare?.())
        expect(host.querySelector('[data-testid="agent-launch-review"]')).toBeNull()
        expect(startAgent).not.toHaveBeenCalled()
        expect(assign).toHaveBeenCalledTimes(1)
        return
      }
      if (outcome === 'wrong-ref') {
        await vi.waitFor(() =>
          expect(host.textContent).toContain('The version or its access changed since you reviewed it.'),
        )
        expect(host.querySelector('[data-testid="agent-launch-confirm"]')).toBeNull()
        expect(startAgent).not.toHaveBeenCalled()
        expect(assign).toHaveBeenCalledTimes(1)
        return
      }
      await vi.waitFor(() => expect(host.querySelector('[data-testid="agent-launch-review"]')).not.toBeNull())
      const technical = host.querySelector('[data-testid="launch-technical"]')
      expect(technical?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
      const human = host.querySelector('[data-testid="agent-launch-review"]')?.cloneNode(true) as HTMLElement
      human.querySelector('[data-testid="launch-technical"]')?.remove()
      expect(human.textContent).not.toContain('Backend editable draft')
      expect(human.textContent).not.toContain('shared.tool')
      if (outcome === 'covered') expect(human.textContent).toContain('already covers this configuration')
      await act(async () => technical?.querySelector<HTMLButtonElement>('button')?.click())
      expect(host.textContent).toContain('reviewed-model')
      expect(host.textContent).toContain('shared.tool')
      expect(host.textContent).toContain('sha512-reviewed')
      expect(host.textContent).toContain('Backend editable draft')
      expect(assign).toHaveBeenCalledTimes(1)
      expect(startAgent).not.toHaveBeenCalled()
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="agent-launch-confirm"]')?.click(),
      )
      expect(startAgent).toHaveBeenCalledWith('reviewed-ticket', expect.any(String))
      const operationId = startAgent.mock.calls[0]?.[1]
      if (outcome === 'unknown') {
        await vi.waitFor(() => expect(host.textContent).toContain('may not have started'))
        expect(host.textContent).toContain('(LOOP_MISSING)')
        expect(host.textContent).not.toContain('OUTCOME_UNKNOWN')
        expect(assign).toHaveBeenCalledTimes(1)
        // An unresolved receipt and another click keep the same launch intent.
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[data-agent-ref="acme/kit#triage"] button')?.click(),
        )
        expect(prepareAgent).toHaveBeenCalledTimes(1)
        // A recheck keeps the failure panel: busy action, other actions off, no starting skeleton.
        let answer: (value: unknown) => void = () => {}
        readAgent.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[data-testid="agent-launch-retry"]')?.click(),
        )
        const retry = host.querySelector<HTMLButtonElement>('[data-testid="agent-launch-retry"]')
        expect(host.textContent).toContain('may not have started')
        expect(retry?.getAttribute('aria-busy')).toBe('true')
        for (const id of ['agent-launch-new-intent', 'agent-launch-close'])
          expect(host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)?.disabled).toBe(true)
        await act(async () => answer({ state: 'unknown', code: 'OUTCOME_UNKNOWN', cause: 'STILL_UNKNOWN' }))
        expect(host.textContent).toContain('(STILL_UNKNOWN)')
        expect(host.querySelector('[data-testid="agent-launch-retry"]')?.getAttribute('aria-busy')).not.toBe(
          'true',
        )
        readAgent.mockResolvedValue({ state: 'completed', ...result })
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[data-testid="agent-launch-retry"]')?.click(),
        )
      }
      await vi.waitFor(() => expect(opened).toHaveLength(1))
      expect(opened[0]).toEqual({ sessionId: 'session-reviewed', prompt: 'Backend editable draft' })
      // Opening the started session is an in-app hand-over, not a document navigation.
      expect(assign).toHaveBeenCalledTimes(1)
      expect(startAgent).toHaveBeenCalledTimes(1)
      if (outcome === 'enable') expect(enabled).toBe(true)
      if (outcome === 'recover' || outcome === 'unknown') expect(readAgent).toHaveBeenCalledWith(operationId)
    } finally {
      window.removeEventListener('agnes:open-session', onOpen)
      await act(async () => root.unmount())
    }
  },
)

it.each([
  ['single-encoded', 'agent-acme%2Fkit%23reply'],
  ['double-encoded', `agent-${encodeURIComponent(encodeURIComponent('acme/kit#reply'))}`],
  ['unknown', 'agent-acme%2Fkit%23gone'],
])('a %s agent link opens the agent start or the list, never an endless wait', async (name, view) => {
  const prepareAgent = vi.fn(() => new Promise<never>(() => {}))
  const startAgent = vi.fn()
  mock.connect.mockResolvedValue({
    context: { permissions: [], readOnly: false },
    api: {
      prepareAgent,
      startAgent,
      catalog: async () => ({ items: [] }),
      list: async () => ({
        packages: [
          {
            id: 'acme/kit',
            version: '1.0.0',
            trusted: true,
            desired: 'enabled',
            actual: 'running',
            agents: [
              {
                ref: 'acme/kit#reply',
                launch: { title: { en: 'reply' }, description: { en: 'reply description' }, preset: 'safe' },
              },
            ],
          },
        ],
      }),
      loops: async () => ({ loops: [], revision: 1, defaults: {} }),
    },
  })
  history.replaceState(null, '', `/?page=agents&view=${view}`)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(AgentsPage, { context: { t: (key) => key } })))
    if (name === 'unknown') {
      await vi.waitFor(() => expect(location.search).not.toContain('view='))
      expect(host.querySelector('[data-agent-ref="acme/kit#reply"]')).not.toBeNull()
      expect(prepareAgent).not.toHaveBeenCalled()
    } else await vi.waitFor(() => expect(prepareAgent).toHaveBeenCalledWith('acme/kit#reply'))
    expect(startAgent).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
  }
})

it('reacts to the effective application for catalog and installed agents, including hidden start links and host fallback', async () => {
  const declaration = (id: string, packageId = 'acme/kit') => ({
    ref: `${packageId}#${id}`,
    launch: { title: { en: id }, description: { en: `${id} description` }, preset: 'safe' },
  })
  const prepareAgent = vi.fn()
  mock.connect.mockResolvedValue({
    context: { permissions: [], readOnly: false },
    api: {
      prepareAgent,
      catalog: async () => ({
        items: [
          {
            id: 'acme/catalog',
            version: '1.0.0',
            agents: [declaration('catalog', 'acme/catalog')],
            source: { type: 'file', ref: 'file:./bundled-examples/showcase/arbitrary-industry' },
          },
          {
            id: 'teaching/tools',
            version: '1.0.0',
            agents: [declaration('lookup', 'teaching/tools')],
            source: { type: 'file', ref: 'file:./bundled-examples/fde/knowledge-qa' },
          },
        ],
      }),
      list: async () => ({
        packages: [
          {
            id: 'acme/kit',
            version: '1.0.0',
            trusted: true,
            desired: 'enabled',
            actual: 'running',
            agents: [declaration('triage'), declaration('reply')],
          },
        ],
      }),
      loops: async () => ({ loops: [], revision: 1, defaults: {} }),
    },
  })
  const state: ApplicationState = {
    revision: 1,
    selection: null,
    status: 'active',
    effective: { id: 'acme', agents: ['acme/catalog#catalog'] },
    assets: {},
    candidates: [],
  }
  applicationIdentity.set(state)
  const query = new URLSearchParams({ view: `agent-${encodeURIComponent('acme/kit#reply')}` })
  history.replaceState(null, '', `/?${query}`)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const refs = () =>
    [...host.querySelectorAll('[data-agent-ref]')].map((card) => card.getAttribute('data-agent-ref'))
  try {
    await act(async () =>
      root.render(
        createElement(AgentsPage, {
          context: {
            t: (key) => key,
            selection: { focus: 'acme/kit', agent: 'acme/kit#reply', start: true },
          },
        }),
      ),
    )
    await vi.waitFor(() => expect(refs()).toEqual(['acme/catalog#catalog']))
    expect(prepareAgent).not.toHaveBeenCalled()
    await act(async () => root.render(createElement(AgentsPage, { context: { t: (key) => key } })))
    await act(async () => {
      history.replaceState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await act(async () => {
      applicationIdentity.set({
        ...state,
        effective: {
          id: 'acme',
          agents: ['acme/catalog#catalog', 'acme/kit#reply'],
          defaultAgent: 'acme/kit#reply',
        },
      })
    })
    expect(refs()).toEqual(['acme/kit#reply', 'acme/catalog#catalog'])
    await act(async () => applicationIdentity.set({ ...state, effective: { id: 'acme' } }))
    expect(refs()).not.toContain('teaching/tools#lookup')
    expect(refs()).toHaveLength(3)
    await act(async () => applicationIdentity.set({ ...state, effective: { id: 'acme', agents: [] } }))
    expect(refs()).toEqual([])
    expect(host.textContent).not.toContain('No agents found')
    expect(host.querySelector('[data-testid="general-agent"]')).not.toBeNull()
    await act(async () =>
      applicationIdentity.set({ ...state, status: 'unresolved', effective: { id: 'acme', agents: [] } }),
    )
    expect(refs()).not.toContain('teaching/tools#lookup')
    expect(refs()).toHaveLength(3)
    await act(async () => applicationIdentity.set(undefined))
    expect(refs()).not.toContain('teaching/tools#lookup')
    expect(refs()).toHaveLength(3)
    expect(prepareAgent).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
  }
})

it.each([false, true])(
  'groups all application roles in one card, including installed offline inventory (%s)',
  async (offline) => {
    const entry = {
      id: '@community/industry',
      version: '1.0.0',
      source: { type: 'file', ref: 'file:./bundled-examples/showcase/arbitrary-industry' },
      application: {
        id: 'industry',
        brand: { title: { en: 'Industry platform' } },
        agents: ['@community/industry#role-0'],
      },
      agents: Array.from({ length: 5 }, (_, index) => ({
        ref: `@community/industry#role-${index}`,
        launch: {
          title: { en: `Role ${index}` },
          description: { en: `Role ${index} description` },
          preset: 'standard',
        },
      })),
    }
    mock.connect.mockResolvedValue({
      context: { permissions: [], readOnly: false },
      api: {
        catalog: async () => {
          if (offline) throw new Error('offline')
          return { items: [entry] }
        },
        list: async () => ({
          packages: offline ? [{ ...entry, trusted: true, desired: 'enabled', actual: 'running' }] : [],
        }),
        loops: async () => ({ loops: [], defaults: {}, revision: 1 }),
      },
    })
    applicationIdentity.set({
      revision: 1,
      status: 'active',
      selection: null,
      effective: entry.application,
      assets: {},
      candidates: [],
    })
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    try {
      await act(async () => root.render(createElement(AgentsPage, { context: { t: (key) => key } })))
      await vi.waitFor(() => expect(host.querySelectorAll('[data-application]')).toHaveLength(1))
      const gallery = host.querySelector('[data-testid="agents-gallery"]')
      expect(gallery?.firstElementChild?.getAttribute('data-testid')).toBe('general-agent')
      expect(gallery?.querySelector('[data-testid="general-agent"] > footer button')).not.toBeNull()
      // Applications share the one feed with the agent cards; the feed decides the packing.
      expect(gallery?.querySelector('[data-application]')).not.toBeNull()
      expect(gallery?.querySelector('[data-application]')?.textContent).not.toContain(entry.id)
      expect(host.querySelector('[data-testid="applications-gallery"]')).toBeNull()
      expect(host.querySelectorAll('.application-roles li')).toHaveLength(5)
      expect(host.textContent).toContain('5 role agents')
      expect(host.querySelectorAll('.application-roles li button')).toHaveLength(offline ? 1 : 0)
      expect(host.querySelectorAll('[data-agent-ref]')).toHaveLength(0)
    } finally {
      await act(async () => root.unmount())
    }
  },
)

it.each(['en', 'zh-CN'])(
  'names the default running mode in %s without exposing the raw ID',
  async (locale) => {
    document.documentElement.lang = locale
    mock.connect.mockResolvedValue({
      context: { permissions: [], readOnly: false },
      api: {
        catalog: async () => ({ items: [] }),
        list: async () => ({ packages: [] }),
        agents: async () => ({ agents: [] }),
        loops: async () => ({
          revision: 1,
          loops: [
            { id: 'custom.loop', version: '1.0.0' },
            { id: 'agnes.default', version: '1.0.0' },
          ],
          defaults: { providers: { loop: { provider: 'custom.loop', version: '1.0.0' } } },
        }),
      },
    })
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const localized = createDocumentLocaleSource({})
    try {
      await act(async () =>
        root.render(
          createElement(
            UiLocaleProvider,
            { source: localized.source },
            createElement(AgentsPage, { context: { t: (key: string) => key } as never }),
          ),
        ),
      )
      await vi.waitFor(() =>
        expect(host.querySelector('[data-testid="general-agent"] .ant-select')?.textContent).toContain(
          locale === 'en' ? 'Official default Agent' : '官方默认智能体',
        ),
      )
      expect(host.querySelector('[data-testid="general-agent"]')?.textContent).not.toContain('agnes.default')
      expect(host.textContent).not.toContain(locale === 'en' ? 'No agents found' : '未发现智能体')
      expect(
        host.querySelector('[data-testid="general-agent"] .agh-disclosure')?.getAttribute('data-open'),
      ).toBe('false')
      expect(host.querySelector('[data-testid="general-agent"] .agh-disclosure-chevron')).not.toBeNull()
      expect(host.textContent).toContain(locale === 'en' ? 'Start conversation' : '开始对话')
    } finally {
      await act(async () => root.unmount())
      localized.dispose()
      document.documentElement.lang = ''
    }
  },
)

it('names the search scope and offers an empty state when nothing matches', async () => {
  mock.connect.mockResolvedValue({
    context: { permissions: [], readOnly: false },
    api: {
      catalog: async () => ({ items: [] }),
      list: async () => ({ packages: [] }),
      loops: async () => ({ loops: [], revision: 1, defaults: {} }),
    },
  })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(AgentsPage, { context: { t: (key) => key } })))
    await vi.waitFor(() => expect(host.querySelector('[data-testid="general-agent"]')).not.toBeNull())
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')
    expect(search?.getAttribute('placeholder')).toBe('Search agents…')
    await act(async () => {
      if (!search) throw new Error('missing agent search')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        'nothing-matches',
      )
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(host.querySelector('.agh-empty-state')).not.toBeNull()
    expect(host.textContent).toContain('No matching agent')
    expect(host.textContent).toContain('Try fewer or different words.')
  } finally {
    await act(async () => root.unmount())
  }
})

it.each(['en', 'zh-CN'] as const)(
  'starts covered application actions directly and summarizes changed launches (%s)',
  async (locale) => {
    document.documentElement.lang = locale
    for (const [via, consent] of (['work', 'composer'] as const).flatMap((via) =>
      (['covered', 'changed', 'unavailable'] as const).map((consent) => [via, consent] as const),
    )) {
      clearResources()
      history.replaceState(null, '', '/')
      const plan: AgentPlan = {
        ref: 'acme/kit#review',
        launch: {
          title: { en: 'Quality reviewer', 'zh-CN': '质量审核员' },
          description: { en: 'Review a batch', 'zh-CN': '复核批次' },
          preset: 'safe',
        },
        loop: { id: 'work', version: '1.0.0' },
        bundles: ['acme/kit#review'],
        preset: 'safe',
        pages: [],
        digest: 'digest',
        compositionHash: 'composition',
        presetHash: 'preset',
        effectivePresetHash: 'effective',
        model: { route: 'demo', model: 'demo' },
        models: {},
        permission: { readOnly: true, tools: [], allow: [], deny: [] },
        sources: [],
      }
      const state: ApplicationState = {
        revision: 1,
        status: 'active',
        assets: {},
        candidates: [],
        selection: {
          packageId: 'acme/kit',
          applicationId: 'acme',
          integrity: 'hash',
          declarationDigest: 'a'.repeat(64),
          consentDigest: 'b'.repeat(64),
          bindingDigest: 'c'.repeat(64),
        },
        effective: {
          id: 'acme',
          agents: [plan.ref],
          defaultAgent: plan.ref,
          workbench: {
            actions: [
              {
                id: 'review',
                title: { en: 'Review', 'zh-CN': '复核' },
                agent: plan.ref,
                prompt: { en: 'Review this batch.', 'zh-CN': '请复核此批次。' },
              },
            ],
          },
        },
      }
      applicationIdentity.set(state)
      const startAgent = vi.fn(async () => ({ sessionId: `${via}-${locale}-${consent}` }))
      const prepareAgent = vi.fn(async (_ref: string, _workspace?: string) => ({
        launchTicket: 'ticket',
        presentation: plan,
        consent,
      }))
      mock.connect.mockResolvedValue({
        context: { permissions: [], readOnly: false },
        api: {
          prepareAgent,
          startAgent,
          catalog: async () => ({ items: [] }),
          loops: async () => ({ loops: [], revision: 1, defaults: {} }),
          runtime: async () => ({ bundles: [{ id: plan.ref, sourcePackage: 'acme/kit' }] }),
          list: async () => ({
            packages: [
              {
                id: 'acme/kit',
                version: '1.0.0',
                source: { type: 'file', ref: 'file:./kit' },
                contributions: [],
                trusted: true,
                desired: 'enabled',
                actual: 'running',
                integrity: 'hash',
                blockers: [],
                agents: [{ ref: plan.ref, launch: plan.launch }],
              },
            ],
          }),
        },
      })
      const host = document.body.appendChild(document.createElement('div'))
      const root = createRoot(host)
      const navHost = document.body.appendChild(document.createElement('div'))
      const navRoot = createRoot(navHost)
      const localized = createDocumentLocaleSource({})
      const assign = vi.spyOn(location, 'assign').mockImplementation(() => {})
      const opened: unknown[] = []
      const onOpen = (event: Event) => opened.push((event as CustomEvent).detail)
      window.addEventListener('agnes:open-session', onOpen)
      let unregister: (() => void) | undefined
      let stopWatching = () => {}
      try {
        const shown: (string | undefined)[] = []
        // What the sidebar selects: a quiet launch must not present the agents page as current either.
        const selected: (string | undefined)[] = []
        stopWatching = watchActiveHomeEntry(() => selected.push(activeHomeEntry()?.id))
        unregister = homeEntries.register({
          id: 'agents',
          icon: 'bot',
          titleKey: 'agents',
          order: 1,
          component: AgentsPage,
        })
        await act(async () =>
          root.render(
            createElement(HomePageHost, {
              locale: { t: (key: string) => key } as never,
              source: localized.source,
              // en: a selected workspace; zh-CN: none selected (launcher default).
              data: { selectedWorkspace: () => (locale === 'en' ? '/selected/ws' : undefined) } as never,
              onActive: (id) => {
                shown.push(id)
              },
            }),
          ),
        )
        await act(async () => navRoot.render(createElement(HomeEntriesNav, { t: (key: string) => key })))
        await act(async () => {
          if (via === 'composer')
            openComposerLaunch({
              agent: plan.ref,
              prompt: 'typed message',
              send: true,
              yolo: true,
              workspace: '/synthetic/work',
            })
          else
            homeNavigation.open('agents', {
              workAction: {
                applicationId: 'acme',
                packageId: 'acme/kit',
                actionId: 'review',
                object: { type: 'batch', id: 'B-017' },
              },
            })
        })
        if (consent === 'covered') expect(shown.every((id) => id === undefined)).toBe(true)
        else await vi.waitFor(() => expect(shown.at(-1)).toBe('agents'))
        if (consent === 'covered') expect(selected.every((id) => id === undefined)).toBe(true)
        else await vi.waitFor(() => expect(selected.at(-1)).toBe('agents'))
        if (consent !== 'covered') {
          const confirm = host.querySelector('[data-testid="agent-launch-confirm"]')
          const cancel = host.querySelector('[data-testid="agent-launch-close"]')
          expect(confirm?.classList.contains('agh-btn--primary')).toBe(true)
          expect(cancel?.classList.contains('agh-btn--secondary')).toBe(true)
          expect(confirm?.parentElement).toBe(cancel?.parentElement)
          await vi.waitFor(() =>
            expect(host.querySelector('[data-testid="agent-launch-review"]')).not.toBeNull(),
          )
          expect(startAgent).not.toHaveBeenCalled()
          expect(host.textContent).toContain(locale === 'en' ? 'Quality reviewer' : '质量审核员')
          if (via === 'work') expect(host.textContent).toContain('B-017')
          expect(
            host.querySelector('[data-testid="launch-technical"] button')?.getAttribute('aria-expanded'),
          ).toBe('false')
          expect(host.textContent).toContain(
            consent === 'changed'
              ? locale === 'en'
                ? 'changed since adoption'
                : '较采用时变化'
              : locale === 'en'
                ? 'not covered'
                : '尚未被当前应用同意覆盖',
          )
          await act(async () =>
            host.querySelector<HTMLButtonElement>('[data-testid="agent-launch-confirm"]')?.click(),
          )
        }
        await vi.waitFor(() => expect(opened).toHaveLength(1))
        if (via === 'composer') expect(prepareAgent).toHaveBeenCalledWith(plan.ref, '/synthetic/work')
        else if (locale === 'en') expect(prepareAgent).toHaveBeenCalledWith(plan.ref, '/selected/ws')
        else expect(prepareAgent).toHaveBeenCalledWith(plan.ref)
        if (consent === 'covered') {
          expect(shown.every((id) => id === undefined)).toBe(true)
          expect(selected.every((id) => id === undefined)).toBe(true)
          expect(navHost.querySelector('[aria-current="page"]')).toBeNull()
        }
        expect(assign).not.toHaveBeenCalled()
        expect(startAgent).toHaveBeenCalledWith('ticket', expect.any(String))
        expect(host.querySelector('[data-testid="agent-launch-review"]')).toBeNull()
        const { applicationWorkDraft } = await import('@agnes/web-client')
        if (via === 'composer') {
          expect(applicationWorkDraft.read(`${via}-${locale}-${consent}`)).toBeUndefined()
          expect(opened[0]).toEqual({
            sessionId: `${via}-${locale}-${consent}`,
            prompt: 'typed message',
            send: true,
            yolo: true,
          })
        } else {
          expect(applicationWorkDraft.read(`${via}-${locale}-${consent}`)?.object?.id).toBe('B-017')
          expect(opened[0]).toEqual({
            sessionId: `${via}-${locale}-${consent}`,
            prompt: locale === 'en' ? 'Review this batch.' : '请复核此批次。',
          })
        }
        expect(startAgent).toHaveBeenCalledTimes(1)
      } finally {
        stopWatching()
        await act(async () => navRoot.unmount())
        navHost.remove()
        await act(async () => root.unmount())
        unregister?.()
        homeNavigation.close()
        host.remove()
        localized.dispose()
        assign.mockRestore()
        window.removeEventListener('agnes:open-session', onOpen)
      }
    }
  },
)
