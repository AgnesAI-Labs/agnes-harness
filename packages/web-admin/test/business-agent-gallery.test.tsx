/** @vitest-environment happy-dom */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentLaunches } from '@agnes/daemon-admin/packages/agent-launches'
import type { PackageCatalogDescriptor, PackageInstalledDescriptor, PackageOperation } from '@agnes/protocol'
import { clearResources, PushStack, searchParamRoute } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginAdminApi } from '../src/admin/plugins/api.js'
import type { AdminContext } from '../src/admin/plugins/types.js'
import { agentsCatalog } from '../src/agents/agents-locale.js'
import { BusinessAgentGallery, useBusinessAgents } from '../src/agents/gallery.js'
import type { StartedSession } from '../src/agents/start-dialog.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const en = (key: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    agentsCatalog.en[key] ?? key,
  )
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
  clearResources()
  history.replaceState(null, '', '/')
})

const ID = '@agnes-fde/data-report'
const entry = (id: string, name: string, sample?: string) =>
  ({
    id,
    version: '1.1.0',
    source: { type: 'file', ref: `file:./bundled-examples/showcase/${id.split('/').at(-1)}` },
    integrity: 'sha512-a',
    license: 'Apache-2.0',
    contributions: [],
    compatibility: 'supported',
    sourceId: 'official-examples',
    retrievedAt: '',
    provides: ['loop', 'tool'],
    agents: [
      {
        ref: `${id}#work`,
        launch: {
          title: { en: name },
          description: { en: name },
          preset: 'safe',
          ...(sample ? { prompt: { mode: 'draft', text: { en: sample } } } : {}),
        },
      },
    ],
    presentation: { origin: 'example', rows: [] },
    metadata: {
      displayName: name,
      summary: `${name} summary`,
      description: '',
      ...(sample ? { samplePrompt: { en: sample } } : {}),
    },
  }) as unknown as PackageCatalogDescriptor

function setup(options: { permissions?: string[]; readOnly?: boolean; ready?: boolean } = {}) {
  let state: PackageInstalledDescriptor | undefined = options.ready
    ? ({
        id: ID,
        version: '1.1.0',
        integrity: 'sha512-a',
        trusted: true,
        desired: 'enabled',
        actual: 'running',
        blockers: [],
        contributions: [],
      } as unknown as PackageInstalledDescriptor)
    : undefined
  const calls: string[] = []
  const done = (name: string, extra: Partial<PackageOperation> = {}) => {
    calls.push(name)
    return Promise.resolve({ operationId: name, profile: 'default', ...extra })
  }
  const operations: Record<string, Partial<PackageOperation>> = {
    inspect: {
      preview: {
        id: ID,
        version: '1.1.0',
        source: entry(ID, 'x').source,
        integrity: 'sha512-a',
        capabilityHash: 'cap',
        provides: ['loop', 'tool'],
        contributions: [{ kind: 'skill', id: 'playbook', path: 'skills/playbook' }],
        blockers: [],
        declaredCapabilities: {
          tools: { prefix: 'report', names: ['read_csv', 'chart'] },
          network: ['api.example.com'],
        },
        provenance: { source: entry(ID, 'x').source, integrity: 'sha512-a', signatureVerified: false },
      } as unknown as NonNullable<PackageOperation['preview']>,
    },
  }
  const api = {
    resolveAgent: async (ref: string) => (await api.prepareAgent(ref)).presentation,
    prepareAgent: async (ref: string) => ({
      launchTicket: 'ticket',
      presentation: {
        ref,
        launch: entry(ID, 'Data report', 'Summarise the sample CSV.').agents![0]!.launch,
        loop: { id: 'fde.data-report', version: '5.0.0' },
        bundles: [ref],
        preset: 'safe',
        model: { route: 'demo', model: 'm' },
        sources: [],
        permission: { readOnly: true, tools: [], allow: [], deny: [] },
      },
    }),
    startAgent: async () => ({
      sessionId: 'agent-session',
      draft: { mode: 'draft', text: { en: 'Summarise the sample CSV.' } },
    }),
    catalog: async () => ({
      items: [
        entry(ID, 'Data report', 'Summarise the sample CSV.'),
        entry('@agnes-fde/knowledge-qa', 'Knowledge answer'),
      ],
      nextCursor: null,
    }),
    list: async () => ({ packages: state ? [state] : [] }),
    inspect: () => done('inspect'),
    install: () => {
      state = {
        id: ID,
        version: '1.1.0',
        integrity: 'sha512-a',
        capabilityHash: 'cap',
        trusted: false,
        desired: 'installed-disabled',
        actual: 'not-running',
        blockers: [],
        contributions: [],
      } as unknown as PackageInstalledDescriptor
      return done('install')
    },
    trust: () => {
      state = { ...(state as PackageInstalledDescriptor), trusted: true }
      return done('trust')
    },
    enable: () => {
      state = { ...(state as PackageInstalledDescriptor), desired: 'enabled', actual: 'running' }
      return done('enable')
    },
    operation: async (id: string) => ({ operationId: id, state: 'completed', ...operations[id] }),
    loops: async () => ({
      loops: [{ id: 'fde.data-report', version: '5.0.0', capabilities: [], sourcePackage: ID }],
    }),
    runtime: async () => ({ bundles: [] }),
  } as unknown as PluginAdminApi
  const context = {
    profile: 'default',
    clientId: 'c',
    readOnly: options.readOnly ?? false,
    permissions: options.permissions ?? [
      'packages.read',
      'packages.install',
      'packages.trust',
      'packages.activate',
    ],
  } as unknown as AdminContext
  return { calls, source: { connect: async () => ({ api, context }) } }
}

async function mount(
  source: ReturnType<typeof setup>['source'],
  openSession: (target: StartedSession) => void,
  focus?: { id: string; start?: boolean },
) {
  function Page() {
    return createElement(BusinessAgentGallery, { data: useBusinessAgents(source), openSession, focus })
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  // Agent FDE is a page whose starts open as pages inside it, named in `?view=`.
  await act(async () =>
    root.render(
      createElement(
        PushStack,
        { rootTitle: 'Agent FDE', route: searchParamRoute('view') },
        createElement(Page),
      ),
    ),
  )
  await vi.waitFor(() => expect(host.querySelector('[data-testid="business-agents-gallery"]')).not.toBeNull())
  return host
}
const click = (selector: string) =>
  act(async () => {
    const node = document.querySelector<HTMLElement>(selector)
    if (!node) throw new Error(selector)
    node.click()
  })

it('does not read the agent catalog until an enabled picker asks for it', async () => {
  const connect = vi.fn(setup({ ready: true }).source.connect)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  function Probe({ enabled }: { enabled: boolean }) {
    const agents = useBusinessAgents({ connect }, { enabled })
    return createElement('span', null, agents.agents.length)
  }
  await act(async () => root.render(createElement(Probe, { enabled: false })))
  expect(connect).not.toHaveBeenCalled()
  expect(host.textContent).toBe('0')
  await act(async () => root.render(createElement(Probe, { enabled: true })))
  await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(host.textContent).toBe('2'))
})

it('shows a card per business agent, with a sample line only where the package has one', async () => {
  const host = await mount(setup().source, () => {})
  expect(host.querySelectorAll('.agent-card')).toHaveLength(2)
  const report = host.querySelector('[data-testid="business-agent-data-report-work"]')
  expect(report?.textContent).toContain('Data report')
  expect(report?.querySelector('[data-testid="business-agent-sample"]')?.textContent).toBe(
    en('try', { prompt: 'Summarise the sample CSV.' }),
  )
  expect(
    host.querySelector(
      '[data-testid="business-agent-knowledge-qa-work"] [data-testid="business-agent-sample"]',
    ),
  ).toBeNull()
  expect(report?.textContent).toContain(en('state.available'))
})

it('asks once with what the package gets, then installs, trusts, enables and opens the session', async () => {
  const kit = setup()
  const opened: StartedSession[] = []
  await mount(kit.source, (target) => opened.push(target))
  await click('[data-testid="business-agent-start-data-report-work"]')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="agent-start-gets"]')).not.toBeNull())
  // Inspecting is all that has happened before the user agrees.
  expect(kit.calls).toEqual(['inspect'])
  const gets = document.querySelector('[data-testid="agent-start-gets"]')?.textContent ?? ''
  expect(gets).toContain(en('gets.tools', { count: 2 }))
  expect(gets).toContain(en('gets.loop'))
  expect(gets).toContain(en('gets.skill'))
  // Network access is declared, so it is listed and marked; nothing claims the opposite.
  expect(gets).toContain(en('gets.network'))
  expect(gets).toContain(en('gets.caution'))
  expect(document.body.textContent).not.toMatch(/read.only|offline/i)
  expect(document.querySelector('[data-testid="agent-start-confirm"]')?.textContent).toBe(
    en('action.install'),
  )
  // The same review page as a marketplace install: hashes under 技术详情, collapsed, no dialog.
  const review = document.querySelector('[data-testid="agent-start-review"]')
  expect(review?.classList.contains('install-review')).toBe(true)
  const technical = review?.querySelector('[data-testid="install-review-technical"]')
  expect(technical?.getAttribute('data-open')).toBe('false')
  expect(technical?.textContent).toContain('sha512-a')
  expect(review?.querySelector('[data-testid="install-review-unverified"]')).not.toBeNull()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await click('[data-testid="agent-start-confirm"]')
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="agent-launch-confirm"]')).not.toBeNull(),
  )
  await click('[data-testid="agent-launch-confirm"]')
  await vi.waitFor(() => expect(opened).toHaveLength(1), { timeout: 5000 })
  expect(kit.calls).toEqual(['inspect', 'install', 'trust', 'enable'])
  expect(opened[0]).toEqual({
    sessionId: 'agent-session',
    prompt: 'Summarise the sample CSV.',
  })
})

it('opens a session at once for a ready agent, and refuses package changes without permission', async () => {
  const ready = setup({ ready: true })
  const { api } = await ready.source.connect()
  const resolve = vi.spyOn(api, 'resolveAgent')
  const prepare = vi.spyOn(api, 'prepareAgent')
  const opened: StartedSession[] = []
  const host = await mount(ready.source, (target) => opened.push(target))
  expect(host.querySelector('[data-testid="business-agent-data-report-work"]')?.textContent).toContain(
    en('state.ready'),
  )
  expect(resolve).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  await click('[data-testid="business-agent-start-data-report-work"]')
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="agent-launch-confirm"]')).not.toBeNull(),
  )
  await click('[data-testid="agent-launch-confirm"]')
  await vi.waitFor(() => expect(opened).toHaveLength(1))
  expect(ready.calls).toEqual([])
  expect(document.querySelector('[data-testid="agent-start-gets"]')).toBeNull()

  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
  const denied = await mount(setup({ permissions: ['packages.read'] }).source, () => {})
  expect(
    denied.querySelector<HTMLButtonElement>('[data-testid="business-agent-start-data-report-work"]')
      ?.disabled,
  ).toBe(true)
})

it('marks the card another surface points at, and starts it when asked to', async () => {
  const kit = setup()
  const host = await mount(kit.source, () => {}, { id: ID })
  expect(host.querySelector('[data-focused]')?.getAttribute('data-package')).toBe(ID)
  // Pointing at a card is not consent to anything.
  expect(kit.calls).toEqual([])
  expect(document.querySelector('[data-testid="agent-start-confirm"]')).toBeNull()

  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
  const started = setup()
  await mount(started.source, () => {}, { id: ID, start: true })
  // The same confirmation as the card's own button: nothing is installed before the user agrees.
  await vi.waitFor(() => expect(document.querySelector('[data-testid="agent-start-confirm"]')).not.toBeNull())
  expect(started.calls).toEqual(['inspect'])
})

it('opens a start as a page inside Agent FDE, and 返回 cancels it before anything is installed', async () => {
  const kit = setup()
  const host = await mount(kit.source, () => {})
  await click('[data-testid="business-agent-start-data-report-work"]')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="agent-start-confirm"]')).not.toBeNull())
  expect(new URL(location.href).searchParams.get('view')).toBe('agent-data-report-work')
  expect([...host.querySelectorAll('.agh-push-crumbs li')].map((item) => item.textContent)).toEqual([
    'Agent FDE',
    'Data report',
  ])
  // The gallery is still there, hidden, under the page.
  expect(host.querySelector('[data-testid="business-agents-gallery"]')?.closest('[hidden]')).not.toBeNull()
  // No dialog: the start is the page.
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await click('[data-testid="push-back"]')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="agent-start-confirm"]')).toBeNull())
  expect(kit.calls).toEqual(['inspect'])
})

it('opens the start of an agent from a link that names its page', async () => {
  history.replaceState(null, '', '/?page=agents&view=agent-data-report-work')
  const kit = setup()
  await mount(kit.source, () => {})
  await vi.waitFor(() => expect(document.querySelector('[data-testid="agent-start-confirm"]')).not.toBeNull())
  expect(kit.calls).toEqual(['inspect'])
})

it.each(['lost', 'unknown'] as const)(
  'keeps the original launch operation after a %s response',
  async (outcome) => {
    const kit = setup({ ready: true })
    const { api } = await kit.source.connect()
    const plan = { ...(await api.prepareAgent(`${ID}#work`)).presentation, digest: 'reviewed-digest' }
    const directory = mkdtempSync(join(tmpdir(), 'agnes-agent-retry-'))
    const sessions: string[] = []
    const operationIds: string[] = []
    let firstRead = true
    let hold: Promise<void> | undefined
    const facade = createAgentLaunches({
      directory,
      backend: {
        caller: async () => ({
          principal: 'synthetic',
          profile: 'default',
          workspace: directory,
          activation: 'one',
        }),
        resolve: async () => plan,
        open: async () => {
          const id = `synthetic-session-${sessions.length + 1}`
          sessions.push(id)
          if (outcome === 'unknown') throw new Error('uncertain dispatch')
          return id
        },
      },
    })
    api.resolveAgent = async () => plan
    api.prepareAgent = async (agent) =>
      (await facade.call({ action: 'prepare', agent })) as Awaited<ReturnType<PluginAdminApi['prepareAgent']>>
    api.startAgent = async (launchTicket, operationId) => {
      operationIds.push(operationId)
      await facade.call({ action: 'start', launchTicket, operationId })
      throw new Error('lost success response')
    }
    api.readAgent = async (operationId) => {
      if (firstRead) {
        firstRead = false
        throw new Error('receipt temporarily unavailable')
      }
      await hold
      return (await facade.call({ action: 'read', operationId })) as Awaited<
        ReturnType<PluginAdminApi['readAgent']>
      >
    }
    const opened: StartedSession[] = []
    try {
      await mount(kit.source, (session) => opened.push(session))
      await click('[data-testid="business-agent-start-data-report-work"]')
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="agent-launch-confirm"]')).not.toBeNull(),
      )
      await click('[data-testid="agent-launch-confirm"]')
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="agent-start-retry"]')).not.toBeNull(),
      )
      expect(sessions).toEqual(['synthetic-session-1'])
      await click('[data-testid="agent-start-retry"]')
      if (outcome === 'lost') {
        await vi.waitFor(() =>
          expect(opened).toEqual([{ sessionId: 'synthetic-session-1', prompt: 'Summarise the sample CSV.' }]),
        )
      } else {
        await vi.waitFor(() =>
          expect(document.querySelector('[data-testid="agent-start-error"]')?.textContent).toContain(
            'OUTCOME_UNKNOWN',
          ),
        )
        expect(document.querySelector('[data-testid="agent-start-new-intent"]')?.textContent).toBe(
          en('launch.another'),
        )
        // A recheck keeps the failure panel with a busy action instead of the running steps.
        let release = () => {}
        hold = new Promise<void>((resolve) => (release = resolve))
        await click('[data-testid="agent-start-retry"]')
        expect(document.querySelector('[data-testid="agent-start-error"]')).not.toBeNull()
        expect(document.querySelector('[data-testid="agent-start-retry"]')?.getAttribute('aria-busy')).toBe(
          'true',
        )
        expect(
          document.querySelector('[data-testid="agent-start-new-intent"]')?.hasAttribute('disabled'),
        ).toBe(true)
        release()
        await vi.waitFor(() =>
          expect(
            document.querySelector('[data-testid="agent-start-retry"]')?.getAttribute('aria-busy'),
          ).not.toBe('true'),
        )
        expect(opened).toEqual([])
      }
      expect(sessions).toEqual(['synthetic-session-1'])
      expect(operationIds).toHaveLength(1)
    } finally {
      for (const root of roots.splice(0)) await act(async () => root.unmount())
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
