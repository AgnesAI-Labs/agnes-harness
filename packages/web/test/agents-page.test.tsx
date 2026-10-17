/** @vitest-environment happy-dom */
import type { AgentPlan, ApplicationState } from '@agnes/protocol'
import { applicationIdentity } from '@agnes/web-client'
import { clearResources } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentsPage } from '../src/pages/agents-page.js'

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

it.each(['success', 'recover', 'unknown', 'wrong-ref', 'cancel', 'enable'] as const)(
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
    const prepareAgent = vi.fn(async (_ref: string) => {
      if (outcome === 'cancel')
        await new Promise<void>((resolve) => {
          finishPrepare = resolve
        })
      return {
        launchTicket: 'reviewed-ticket',
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
          ? { state: 'unknown', code: 'OUTCOME_UNKNOWN' }
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
        loops: async () => ({ loops }),
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
    try {
      await act(async () => root.render(createElement(AgentsPage, { context: { t: (key) => key } })))
      await vi.waitFor(() => expect(host.querySelectorAll('[data-agent-ref]')).toHaveLength(2))
      expect(host.querySelectorAll('[data-testid="plugin-primary-status"][data-state="ready"]')).toHaveLength(
        2,
      )
      expect(host.textContent).toContain('triage description')
      expect(host.textContent).toContain('acme/kit')
      const general = host.querySelector('[data-testid="general-agent"]')
      await vi.waitFor(() =>
        expect(general?.querySelector('button:not([aria-haspopup])')?.hasAttribute('disabled')).toBe(false),
      )
      // The picker is a native public Select: keyboard choice selects the requested provider.
      await act(async () =>
        general?.querySelector('input')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
      )
      const option = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
        (item) => item.textContent === 'Chat',
      )
      await act(async () => option?.click())
      const start = [...(general?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === 'Start now',
      )
      await act(async () => start?.click())
      expect(assign).toHaveBeenCalledWith('/?new=1&loop=acme.chat%402.0.0')
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
      expect(host.textContent).toContain('reviewed-model')
      expect(host.textContent).toContain('shared.tool')
      expect(host.textContent).toContain('shared/tools@2.0.0 sha512-reviewed')
      expect(host.textContent).toContain('Backend editable draft')
      expect(assign).toHaveBeenCalledTimes(1)
      expect(startAgent).not.toHaveBeenCalled()
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="agent-launch-confirm"]')?.click(),
      )
      expect(startAgent).toHaveBeenCalledWith('reviewed-ticket', expect.any(String))
      const operationId = startAgent.mock.calls[0]?.[1]
      if (outcome === 'unknown') {
        await vi.waitFor(() => expect(host.textContent).toContain('OUTCOME_UNKNOWN'))
        expect(assign).toHaveBeenCalledTimes(1)
        // An unresolved receipt and another click keep the same launch intent.
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[data-agent-ref="acme/kit#triage"] button')?.click(),
        )
        expect(prepareAgent).toHaveBeenCalledTimes(1)
        readAgent.mockResolvedValue({ state: 'completed', ...result })
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[data-testid="agent-launch-retry"]')?.click(),
        )
      }
      await vi.waitFor(() =>
        expect(assign).toHaveBeenLastCalledWith('/?session=session-reviewed&prompt=Backend+editable+draft'),
      )
      expect(startAgent).toHaveBeenCalledTimes(1)
      if (outcome === 'enable') expect(enabled).toBe(true)
      if (outcome === 'recover' || outcome === 'unknown') expect(readAgent).toHaveBeenCalledWith(operationId)
    } finally {
      await act(async () => root.unmount())
    }
  },
)

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
      loops: async () => ({ loops: [] }),
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
    expect(refs()).toHaveLength(3)
    await act(async () => applicationIdentity.set({ ...state, effective: { id: 'acme', agents: [] } }))
    expect(refs()).toEqual([])
    expect(host.querySelector('[data-testid="general-agent"]')).not.toBeNull()
    await act(async () =>
      applicationIdentity.set({ ...state, status: 'unresolved', effective: { id: 'acme', agents: [] } }),
    )
    expect(refs()).toHaveLength(3)
    await act(async () => applicationIdentity.set(undefined))
    expect(refs()).toHaveLength(3)
    expect(prepareAgent).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
  }
})
