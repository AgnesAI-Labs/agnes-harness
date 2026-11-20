/** @vitest-environment happy-dom */

import {
  DEFAULT_REFINEMENT_SETTINGS,
  type RefinementSettingsSaveParams,
  type RefinementSettingsSnapshot,
} from '@agnes/protocol'
import { homeNavigation } from '@agnes/web-client'
import { fireEvent, getByLabelText, getByRole, getByTestId, getByText } from '@testing-library/dom'
import { expect, it, vi } from 'vitest'
import { registerBuiltinHomeEntries } from '../src/pages/entries.js'
import { type HomePageData, mountHomePages } from '../src/pages/host.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

vi.mock('../src/pages/admin-api.js', () => ({
  homeAdmin: async () => ({ api: { candidatesList: async () => ({ candidates: [] }) } }),
}))

it('opens RSI from the sidebar and applies settings and workspace skill actions through the workbench ports', async () => {
  const runtime = await mountRenderedIndex()
  const revision = () => String(saved.length).padStart(64, '0')
  const saved: RefinementSettingsSaveParams[] = []
  const endpoints = ['https://review.example/v1', 'https://alternate.example/v1']
  const credential = {
    id: 'secret://generic/00000000-0000-4000-8000-000000000000',
    label: 'Task experience service key',
    kind: 'api-key',
    createdAt: '2026-01-01T00:00:00.000Z',
    references: [],
  }
  const skill = {
    name: 'review-checklist',
    resourceId: 'review-checklist',
    revision: revision(),
    state: 'active',
    reviewAfter: Date.UTC(2026, 11, 31),
    initiator: 'user',
    previous: [],
  }
  const call = vi.fn(async (method: string, params: unknown) => {
    switch (method) {
      case '_agnes/v1/refinement.get':
        return {
          settings: saved.at(-1)?.settings ?? DEFAULT_REFINEMENT_SETTINGS,
          revision: revision(),
          endpoints,
        } satisfies RefinementSettingsSnapshot
      case '_agnes/v1/refinement.models':
        return {
          models: (saved.at(-1)?.settings.baseUrl === endpoints[1]
            ? ['alternate', 'preferred']
            : ['default']
          ).map((id) => ({ id, name: id, contextWindow: 65536, maxTokens: 4096 })),
        }
      case '_agnes/v1/refinement.save':
        expect(params).toMatchObject({ expectedRevision: revision() })
        saved.push(params as RefinementSettingsSaveParams)
        return { revision: revision() }
      case '_agnes/v1/workspace.list':
        return {
          items: ['/first', '/second'].map((path) => ({
            path,
            name: path.slice(1),
            lastUsedAt: null,
            sessionCount: 0,
            available: true,
          })),
        }
      case '_agnes/v1/refinement.skills':
        return { skills: (params as { action: string }).action === 'uninstall' ? [] : [skill], drafts: [] }
      default:
        throw new Error(`Unexpected page call: ${method}`)
    }
  })
  const replacement = { ...credential, id: 'secret://generic/00000000-0000-4000-8000-000000000001' }
  const created = [credential, replacement]
  const fetch = vi.fn(async (url: string, _init: RequestInit) =>
    Response.json(url === '/admin/api/credentials/create' ? created.shift() : {}),
  )
  vi.stubGlobal('fetch', fetch)
  const unregister = registerBuiltinHomeEntries()
  const home = mountHomePages(getByHomeMount(), {
    locale: runtime.locale,
    data: {
      call: call as HomePageData['call'],
      sessionId: () => undefined,
      openSettings: () => undefined,
      startDraft: () => undefined,
    },
  })
  try {
    const entry = await vi.waitFor(() => getByRole(document.body, 'button', { name: 'RSI' }))
    entry.click()
    const page = await vi.waitFor(() => getByTestId(document.body, 'home-page-rsi'))
    expect(getByRole(page, 'heading', { name: 'RSI' })).toBeTruthy()
    await vi.waitFor(() => expect(getByTestId(page, 'refinement-endpoint')).toBeTruthy())
    expect(call).toHaveBeenCalledWith('_agnes/v1/refinement.get', {})
    const select = (id: string) => getByTestId<HTMLSelectElement>(page, id)
    const model = select('refinement-model')
    const enabled = getByTestId(page, 'refinement-enabled')

    fireEvent.input(getByLabelText(page, 'Service key'), {
      target: { value: 'synthetic-rsi-key' },
    })
    getByRole(page, 'button', { name: 'Save key' }).click()
    await vi.waitFor(() => expect(model.value).toBe('default'))
    expect(fetch).toHaveBeenCalledWith(
      '/admin/api/credentials/create',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ label: credential.label, value: 'synthetic-rsi-key' }),
      }),
    )
    expect(saved[0]?.settings).toMatchObject({ credentialRef: credential.id, enabled: false })
    expect(call).toHaveBeenCalledWith('_agnes/v1/refinement.models', {})

    await vi.waitFor(() => expect(model.disabled).toBe(false))
    fireEvent.change(select('refinement-endpoint'), { target: { value: endpoints[1] } })
    await vi.waitFor(() => {
      expect(model.value).toBe('alternate')
      expect(model.disabled).toBe(false)
    })
    fireEvent.change(model, { target: { value: 'preferred' } })
    await vi.waitFor(() => {
      expect(saved.at(-1)?.settings).toMatchObject({ baseUrl: endpoints[1], model: 'preferred' })
      expect(model.disabled).toBe(false)
    })
    enabled.click()
    await vi.waitFor(() => expect(enabled.getAttribute('aria-checked')).toBe('true'))
    const mode = select('refinement-mode')
    await vi.waitFor(() => expect(mode.disabled).toBe(false))
    fireEvent.change(mode, { target: { value: 'auto' } })
    await vi.waitFor(() => expect(saved.at(-1)?.settings).toMatchObject({ enabled: true, mode: 'auto' }))
    await vi.waitFor(() => expect(mode.disabled).toBe(false))
    enabled.click()
    await vi.waitFor(() => expect(enabled.getAttribute('aria-checked')).toBe('false'))
    expect(saved.at(-1)?.settings).toMatchObject({ enabled: false, mode: 'auto' })
    // Replacing the key binds the new one, then asks the credential store to delete the old one; the
    // request is not forced, so a key something else uses is kept.
    getByRole(page, 'button', { name: 'Replace key' }).click()
    fireEvent.input(await vi.waitFor(() => getByLabelText(page, 'Service key')), {
      target: { value: 'synthetic-rsi-replacement' },
    })
    getByRole(page, 'button', { name: 'Save key' }).click()
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/admin/api/credentials/delete',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: credential.id }) }),
      ),
    )
    expect(saved.at(-1)?.settings).toMatchObject({ credentialRef: replacement.id, enabled: false })

    const skills = getByTestId(page, 'refinement-saved-skills')
    await vi.waitFor(() => expect(getByText(skills, skill.name)).toBeTruthy())
    expect(call).toHaveBeenCalledWith('_agnes/v1/workspace.list', {})
    expect(call).toHaveBeenCalledWith('_agnes/v1/refinement.skills', { cwd: '/first', action: 'list' })
    fireEvent.change(select('refinement-skills-workspace'), { target: { value: '/second' } })
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith('_agnes/v1/refinement.skills', { cwd: '/second', action: 'list' }),
    )
    const uninstall = await vi.waitFor(() => getByRole(skills, 'button', { name: 'Uninstall' }))
    uninstall.click()
    await vi.waitFor(() =>
      expect(getByText(skills, 'No skills have been saved in this workspace.')).toBeTruthy(),
    )
    expect(call).toHaveBeenCalledWith('_agnes/v1/refinement.skills', {
      cwd: '/second',
      action: 'uninstall',
      name: skill.name,
    })
  } finally {
    home.dispose()
    homeNavigation.close()
    unregister()
    vi.unstubAllGlobals()
    await runtime.dispose()
    resetWebDom()
  }
})

function getByHomeMount(): HTMLElement {
  const host = document.getElementById('home-page')
  if (!host) throw new Error('The home page host is missing')
  return host
}
