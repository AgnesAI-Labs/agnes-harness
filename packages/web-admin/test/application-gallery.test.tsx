/** @vitest-environment happy-dom */
import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { applicationIdentity, homeNavigation } from '@agnes/web-client'
import {
  appServerErrorMessage,
  clearResources,
  createDocumentLocaleSource,
  PushStack,
  searchParamRoute,
  UiLocaleProvider,
} from '@agnes/web-ui'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AdminApiError, type PluginAdminApi } from '../src/admin/plugins/api.js'
import { agentsCatalog } from '../src/agents/agents-locale.js'
import { ApplicationCard } from '../src/agents/application-card.js'
import type { BusinessAgentsData } from '../src/agents/gallery.js'
import { START_FAILURE_CODES, StartError } from '../src/agents/start-flow.js'

const planFailure = vi.hoisted(() => ({ error: undefined as unknown }))
vi.mock('../src/agents/start-flow.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/agents/start-flow.js')>()
  return {
    ...actual,
    planBusinessAgentStart: (...args: Parameters<typeof actual.planBusinessAgentStart>) => {
      if (planFailure.error) throw planFailure.error
      return actual.planBusinessAgentStart(...args)
    },
  }
})

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => {
  document.body.replaceChildren()
  history.replaceState(null, '', '/')
  clearResources()
  applicationIdentity.set(undefined)
  vi.restoreAllMocks()
  planFailure.error = undefined
  document.documentElement.lang = ''
})

it.each(['adopt', 'stale', 'readonly', 'denied', 'cancel'] as const)(
  'reviews package admission and application consent separately (%s)',
  async (outcome) => {
    const entry: PackageCatalogDescriptor = {
      id: '@community/quality',
      version: '1.0.0',
      source: { type: 'file', ref: 'file:./quality' },
      integrity: `sha256-${'a'.repeat(64)}`,
      license: 'Apache-2.0',
      sourceId: 'test',
      retrievedAt: '2026-10-20T00:00:00Z',
      compatibility: 'supported',
      contributions: [],
      metadata: {
        displayName: 'Quality',
        description: 'Synthetic programme quality application',
        summary: 'Investigate evidence, review decisions and retain traceability.',
      },
      application: {
        id: 'quality',
        brand: { title: { en: 'Quality Workbench' } },
        presentation: { home: '@community/quality#home' },
        agents: ['@community/quality#qa', '@community/quality#mrb'],
      },
      agents: ['qa', 'mrb'].map((role) => ({
        ref: `@community/quality#${role}`,
        launch: { title: { en: role }, description: { en: `${role} quality role` }, preset: 'standard' },
      })),
    }
    let installed: PackageInstalledDescriptor | undefined
    const mutations: string[] = []
    const reviewed = { ...entry, blockers: [], capabilityHash: 'capability' }
    const api = {
      list: async () => ({ packages: installed ? [installed] : [] }),
      inspect: vi.fn(async () => ({ operationId: 'inspect' })),
      operation: async () => ({ state: 'completed', preview: reviewed }),
      install: vi.fn(async () => {
        mutations.push('install')
        installed = {
          ...reviewed,
          trusted: false,
          desired: 'installed-disabled',
          actual: 'not-running',
          blockers: [],
        } as PackageInstalledDescriptor
        return { operationId: 'install' }
      }),
      trust: vi.fn(async () => {
        mutations.push('trust')
        installed = { ...installed!, trusted: true }
        return { operationId: 'trust' }
      }),
      enable: vi.fn(async () => {
        mutations.push('enable')
        installed = { ...installed!, desired: 'enabled', actual: 'running' }
        return { operationId: 'enable' }
      }),
      application: async () => ({ revision: 7 }),
      previewApplication: vi.fn(async () => ({
        packageId: entry.id,
        version: entry.version,
        integrity: entry.integrity,
        source: entry.source,
        signature: 'unverified',
        assets: {},
        declaration: entry.application!,
        declarationDigest: 'b'.repeat(64),
        consentDigest: 'c'.repeat(64),
        dependencies: [],
        dependencyDiff: { status: 'known', added: [], removed: [] },
        replacedRoles: [],
        scope: 'presentation-defaults-and-agent-catalogue',
        recovery: '/?admin',
        warning: 'trusted-javascript-is-not-a-sandbox',
      })),
      adoptApplication: vi.fn(async () => {
        if (outcome === 'stale') throw new Error('CONFIG_REVISION_CONFLICT')
        mutations.push('adopt')
        return { status: 'active', selection: { packageId: entry.id } }
      }),
      prepareAgent: vi.fn(),
      startAgent: vi.fn(),
    }
    const data: BusinessAgentsData = {
      api: api as unknown as PluginAdminApi,
      agents: [],
      installed: [],
      readyAgents: [],
      features: [],
      denied: undefined,
      adoptionDenied: outcome === 'readonly' ? 'readOnly' : outcome === 'denied' ? 'noPermission' : undefined,
      busy: false,
      failed: false,
      error: undefined,
      catalogError: undefined,
      loaded: true,
      reload() {},
      refreshInstalled() {},
    }
    const host = document.body.appendChild(document.createElement('div')),
      root = createRoot(host)
    const assign = vi.spyOn(location, 'assign').mockImplementation(() => {})
    const click = async (text: string) =>
      act(async () => {
        const button = [...host.querySelectorAll('button')].find((node) => node.textContent === text)
        expect(button).toBeDefined()
        button!.click()
      })
    try {
      await act(async () =>
        root.render(
          <PushStack rootTitle="Applications" route={searchParamRoute('view')}>
            <ApplicationCard entry={entry} data={data} />
          </PushStack>,
        ),
      )
      expect(host.querySelectorAll('[data-application]')).toHaveLength(1)
      expect(host.querySelectorAll('[data-agent-ref]')).toHaveLength(0)
      expect(host.textContent).toContain('2 role agents')
      expect(host.querySelector('.application-roles .agh-disclosure-chevron')).not.toBeNull()
      if (outcome === 'readonly' || outcome === 'denied') {
        expect(
          [...host.querySelectorAll('button')].find((node) => node.textContent === 'Install and adopt')
            ?.disabled,
        ).toBe(true)
        expect(mutations).toEqual([])
        return
      }
      await click('Install and adopt')
      await vi.waitFor(() => expect(host.querySelector('[data-testid="install-review"]')).not.toBeNull())
      expect(mutations).toEqual([])
      expect(api.previewApplication).not.toHaveBeenCalled()
      if (outcome === 'cancel') {
        await click('Cancel')
        expect(mutations).toEqual([])
        return
      }
      await click('Install, trust and enable')
      await vi.waitFor(() => expect(host.querySelector('[data-testid="consent-summary"]')).not.toBeNull())
      expect(mutations).toEqual(['install', 'trust', 'enable'])
      expect(api.adoptApplication).not.toHaveBeenCalled()
      expect(host.textContent).toContain('Trusted JavaScript is not a sandbox')
      await click('Adopt')
      await vi.waitFor(() => expect(api.adoptApplication).toHaveBeenCalledWith(entry.id, 7, 'c'.repeat(64)))
      if (outcome === 'stale') {
        expect(host.textContent).toContain('CONFIG_REVISION_CONFLICT')
        expect(assign).not.toHaveBeenCalled()
      } else expect(assign).toHaveBeenCalledWith('/')
      expect(api.prepareAgent).not.toHaveBeenCalled()
      expect(api.startAgent).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
    }
  },
)

it.each(['missing', 'installed', 'adopted', 'unresolved'] as const)(
  'shows the generic card action for %s state and reacts to adoption',
  async (state) => {
    const entry = {
      id: 'test/plain-app',
      version: '1.0.0',
      contributions: [],
      source: { type: 'file', ref: 'file:./plain' },
      integrity: 'sha256-' + 'a'.repeat(64),
      license: 'MIT',
      compatibility: 'supported',
      sourceId: 'test',
      retrievedAt: '2026-10-20T00:00:00Z',
      application: { id: 'plain', brand: { title: { en: 'Plain application' } } },
    } as PackageCatalogDescriptor
    const data = {
      api: {},
      installed:
        state === 'missing' ? [] : [{ ...entry, trusted: true, desired: 'enabled', actual: 'running' }],
      refreshInstalled() {},
    } as unknown as BusinessAgentsData
    const application = {
      revision: 1,
      status: state === 'unresolved' ? 'unresolved' : 'active',
      selection: { packageId: entry.id },
      effective: entry.application,
      assets: {},
      candidates: [],
    } as const
    if (state === 'adopted' || state === 'unresolved') applicationIdentity.set(application as never)
    const host = document.body.appendChild(document.createElement('div')),
      root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <PushStack rootTitle="Applications" route={searchParamRoute('view')}>
            <ApplicationCard entry={entry} data={data} />
          </PushStack>,
        ),
      )
      const primary = () => host.querySelector<HTMLButtonElement>('[data-application] footer button')
      expect(host.querySelector('.application-roles')).toBeNull()
      expect(host.querySelector('[data-application]')?.textContent).not.toContain(entry.id)
      expect(host.querySelector('.agent-card-heading')?.textContent).not.toContain('Agnes Harness')
      expect(primary()?.textContent).toBe(
        state === 'missing' ? 'Install and adopt' : state === 'adopted' ? 'Open' : 'Adopt',
      )
      expect(host.querySelectorAll('[data-application] .agh-btn--primary')).toHaveLength(1)
      await act(async () => applicationIdentity.set({ ...application, status: 'active' } as never))
      expect(primary()?.textContent).toBe('Open')
      homeNavigation.open('agents')
      await act(async () => primary()?.click())
      expect(homeNavigation.getSnapshot()).toBeUndefined()
    } finally {
      await act(async () => root.unmount())
    }
  },
)

const missingApp = {
  id: 'test/failing-app',
  version: '1.0.0',
  contributions: [],
  source: { type: 'file', ref: 'file:./failing' },
  integrity: `sha256-${'a'.repeat(64)}`,
  license: 'MIT',
  compatibility: 'supported',
  sourceId: 'test',
  retrievedAt: '2026-10-20T00:00:00Z',
  application: { id: 'failing', brand: { title: { en: 'Failing application' } } },
} as PackageCatalogDescriptor

/** Renders the card in `lang`, makes the start check fail with `error`, and returns the card text. */
async function cardTextAfterFailedStart(lang: 'en' | 'zh-CN', error: unknown, api: object = {}) {
  document.documentElement.lang = lang
  planFailure.error = error
  const data = { api, installed: [], refreshInstalled() {} } as unknown as BusinessAgentsData
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const locale = createDocumentLocaleSource({})
  try {
    await act(async () =>
      root.render(
        <UiLocaleProvider source={locale.source}>
          <PushStack rootTitle="Applications" route={searchParamRoute('view')}>
            <ApplicationCard entry={missingApp} data={data} />
          </PushStack>
        </UiLocaleProvider>,
      ),
    )
    const start = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === (lang === 'en' ? 'Install and adopt' : '安装并采用'),
    )
    expect(start).toBeDefined()
    await act(async () => start!.click())
    await vi.waitFor(() => expect(host.querySelector('.agh-banner')).not.toBeNull())
    return host.querySelector('.agh-banner')?.textContent ?? ''
  } finally {
    locale.dispose()
    await act(async () => root.unmount())
  }
}

it.each(
  START_FAILURE_CODES.flatMap((code) => (['en', 'zh-CN'] as const).map((lang) => [code, lang] as const)),
)('the application card words start failure %s in %s, never the raw code', async (code, lang) => {
  const text = await cardTextAfterFailedStart(lang, new StartError({ step: 'install', code }))
  // The banner is exactly the localized copy: no raw code token is left to show.
  expect(text).toBe(agentsCatalog[lang]?.[`reason.${code}`])
  expect(text).not.toBe(code)
})

it.each(['en', 'zh-CN'] as const)(
  'the application card keeps the diagnostic ID of an internal error (%s)',
  async (lang) => {
    const id = '474ff098-190d-4aab-8ebf-4fc5aee12097'
    const envelope = {
      code: -32603,
      message: 'INTERNAL_ERROR',
      data: { code: 'E_ADMIN_BACKEND', messageKey: 'appServer.errors.internal', diagnosticId: id },
    }
    document.documentElement.lang = lang
    const message = appServerErrorMessage(envelope, lang)
    const list = async () => {
      throw new AdminApiError({ code: 'E_ADMIN_BACKEND', message: message! })
    }
    // The real planner turns the failing read into a StartError that carries the safe message.
    const text = await cardTextAfterFailedStart(lang, undefined, { list })
    expect(text).toContain(lang === 'en' ? `Diagnostic ID: ${id}` : `诊断 ID：${id}`)
  },
)
