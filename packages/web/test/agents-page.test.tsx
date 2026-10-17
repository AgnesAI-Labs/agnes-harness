/** @vitest-environment happy-dom */
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
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

it('shows installed explicit agents even without a catalog and starts the general assistant on a directly chosen Loop', async () => {
  const loops = [
    { id: 'acme.workflow', version: '1.0.0', label: 'Workflow', sourcePackage: 'acme/kit' },
    { id: 'acme.chat', version: '2.0.0', label: 'Chat', sourcePackage: '@agnes/loop-default' },
  ]
  mock.connect.mockResolvedValue({
    context: { permissions: [], readOnly: false },
    api: {
      catalog: async () => {
        throw new Error('offline catalog')
      },
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
            desired: 'enabled',
            actual: 'running',
            blockers: [],
            primaryStatus: {
              state: 'ready',
              reason: { en: 'Backend confirmed', 'zh-CN': '后台已确认' },
              nextAction: 'none',
            },
            agents: ['triage', 'reply'].map((id) => ({
              ref: `acme/kit#${id}`,
              launch: { title: { en: id }, description: { en: `${id} description` }, preset: 'safe' },
            })),
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
    expect(host.querySelectorAll('[data-testid="plugin-primary-status"][data-state="ready"]')).toHaveLength(2)
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
    await vi.waitFor(() =>
      expect(assign).toHaveBeenLastCalledWith(
        '/?new=1&preset=safe&loop=acme.workflow%401.0.0&bundle=acme%2Fkit%23reply',
      ),
    )
  } finally {
    await act(async () => root.unmount())
  }
})
