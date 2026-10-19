/** @vitest-environment happy-dom */
import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { clearResources, PushStack, searchParamRoute } from '@agnes/web-ui'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginAdminApi } from '../src/admin/plugins/api.js'
import { ApplicationCard } from '../src/agents/application-card.js'
import type { BusinessAgentsData } from '../src/agents/gallery.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => {
  document.body.replaceChildren()
  history.replaceState(null, '', '/')
  clearResources()
  vi.restoreAllMocks()
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
      await click('Adopt this preview')
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
