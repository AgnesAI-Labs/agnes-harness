/** @vitest-environment happy-dom */
import type {
  ApplicationPreview,
  ApplicationState,
  PackagePinsInspectResult,
  RuntimeAdminSnapshot,
} from '@agnes/protocol'
import { clearResources, installFeedbackSink } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PluginAdminApi } from '../src/admin/plugins/api.js'
import { ApplicationPanel } from '../src/settings/application.js'
import { InterfaceImplementations } from '../src/settings/interface-implementations.js'
import { PinsPanel } from '../src/settings/pins.js'
import { GenerationsPanel, LocalPluginsPanel } from '../src/settings/runtime-panels.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const state: ApplicationState = {
  revision: 1,
  selection: null,
  status: 'host',
  effective: null,
  assets: {},
  candidates: [{ packageId: 'test/app', applicationId: 'test', version: '1.0.0', available: true }],
  roles: [
    {
      role: 'navigation',
      source: 'default',
      status: 'resolved',
      selection: null,
      effective: null,
      candidates: [{ packageId: 'test/app', clientId: 'nav', version: '1.0.0' }],
    },
  ],
}
const pin = (id: string): PackagePinsInspectResult => ({
  orphans: [
    {
      pinId: id,
      purpose: 'recovery',
      packageId: 'test/app',
      version: '1.0.0',
      snapshotId: id,
      operationId: id,
    },
  ],
})
const t = (key: string) => key
const api = () =>
  new PluginAdminApi({
    profile: 'test',
    clientId: 'test',
    authScope: 'test',
    readOnly: false,
    permissions: ['packages.read', 'packages.activate', 'packages.remove'],
  })

it.each(['application', 'role', 'pins', 'migration', 'local-plugins'] as const)(
  'keeps a late %s failure out of a newer admin connection',
  async (site) => {
    let reject!: (reason: unknown) => void
    const pending = new Promise<never>((_ok, fail) => {
      reject = fail
    })
    const first = api(),
      next = api()
    for (const connection of [first, next]) vi.spyOn(connection, 'application').mockResolvedValue(state)
    vi.spyOn(first, 'previewApplication').mockImplementation(() => pending as Promise<ApplicationPreview>)
    vi.spyOn(first, 'previewRole').mockImplementation(() => pending as Promise<ApplicationPreview>)
    vi.spyOn(first, 'pinsInspect').mockImplementation(() => pending)
    vi.spyOn(next, 'pinsInspect').mockResolvedValue(pin('new-connection-pin'))
    vi.spyOn(first, 'migrateSession').mockImplementation(() => pending)
    vi.spyOn(first, 'reloadLocal').mockImplementation(() => pending)
    const onChange = vi.fn(),
      onRefresh = vi.fn(async () => {})
    const notices: unknown[] = []
    const stopFeedback = installFeedbackSink({ publish: (notice) => notices.push(notice), resolve() {} })
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const draw = (connection: PluginAdminApi) =>
      act(async () => {
        const node =
          site === 'application'
            ? createElement(ApplicationPanel, { api: connection, canSave: true })
            : site === 'role'
              ? createElement(InterfaceImplementations, { api: connection, state, canSave: true, onChange })
              : site === 'pins'
                ? createElement(PinsPanel, { api: connection, canRelease: true, t })
                : site === 'migration'
                  ? createElement(GenerationsPanel, {
                      api: connection,
                      status: undefined,
                      canSave: true,
                      t,
                      onRefresh,
                    })
                  : createElement(LocalPluginsPanel, {
                      api: connection,
                      snapshot: {
                        providers: [],
                        presets: [],
                        localPluginFolders: { home: '/test/home', workspace: '/test/workspace' },
                      } satisfies RuntimeAdminSnapshot,
                      canSave: true,
                      t,
                      onRefresh,
                    })
        root.render(node)
      })
    const click = (selector: string) =>
      act(async () => {
        const button = host.querySelector<HTMLButtonElement>(selector)
        expect(button).not.toBeNull()
        button?.click()
      })
    try {
      await draw(first)
      if (site === 'application' || site === 'role') {
        const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Preview')!
        expect(button).toBeTruthy()
        await act(async () => button.click())
      } else if (site === 'migration') {
        await act(async () => {
          const input = host.querySelector<HTMLInputElement>('[data-testid="migration-session-key"]')!
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
            input,
            'test-session',
          )
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await click('[data-testid="migrate-session"]')
        await click('[data-testid="confirm-session-migration"]')
      } else if (site === 'local-plugins') await click('[data-testid="reload-local-plugins"]')
      await draw(next)
      await act(async () => reject(new Error('old connection failure')))
      expect(host.querySelector('[role="alert"]')).toBeNull()
      expect(onChange).not.toHaveBeenCalled()
      expect(onRefresh).not.toHaveBeenCalled()
      expect(notices).toEqual([])
      if (site === 'pins') expect(host.textContent).not.toContain('pinsUnavailable')
    } finally {
      await act(async () => root.unmount())
      stopFeedback()
      host.remove()
      clearResources()
      vi.restoreAllMocks()
    }
  },
)
