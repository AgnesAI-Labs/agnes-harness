/** @vitest-environment happy-dom */
import { modelSettingsLocaleCatalog } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginAdminApi } from '../src/admin/plugins/api.js'
import { ModelSlotsPanel } from '../src/settings/model-slots.js'
import { AutoReviewPanel } from '../src/settings/auto-review.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let state = {
  revision: 1,
  slots: {},
  canSave: true,
  modelAdapters: [
    {
      id: 'local',
      version: '1',
      api: 'scripted',
      sourcePackage: 'local',
      capabilities: { imageInput: false, tools: true, streaming: true },
      models: [{ route: 'local', id: 'reviewer', label: 'Local' }],
    },
  ],
}
const writes: unknown[] = []
let failSave = false
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  writes.length = 0
  failSave = false
})
async function mount(canSave = true) {
  state = { ...state, revision: 1, slots: {}, canSave }
  vi.spyOn(PluginAdminApi, 'context').mockResolvedValue({} as never)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/admin/api/auto-review') return new Response(JSON.stringify({ modelSlot: 'fast' }))
      if (options?.method === 'POST') {
        writes.push(JSON.parse(String(options.body)))
        if (failSave) return new Response('{}', { status: 409 })
        state = { ...state, ...JSON.parse(String(options.body)), revision: state.revision + 1 }
      }
      return new Response(JSON.stringify(state))
    }),
  )
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      createElement(
        'div',
        {},
        createElement(ModelSlotsPanel, { t: (key) => modelSettingsLocaleCatalog.en[key] ?? key }),
        createElement(AutoReviewPanel, { canSave }),
      ),
    ),
  )
  return host
}
async function choose(host: HTMLElement, slot: string, value: string) {
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>(`#model-slot-${slot}`)!
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
it('shows unset reviewer status, saves explicit profile targets and refreshes the security card', async () => {
  const host = await mount()
  expect(host.querySelector('[data-testid="auto-review-slot-status"]')?.textContent).toContain('not set')
  expect(host.querySelector('a')?.getAttribute('href')).toBe('?settings=model#auxiliary-models')
  await choose(host, 'fast', JSON.stringify(['local', 'reviewer']))
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="model-slots-save"]')?.click())
  expect(writes).toEqual([{ revision: 1, slots: { fast: { route: 'local', model: 'reviewer' } } }])
  expect(host.querySelector('[data-testid="auto-review-slot-status"]')?.textContent).toContain(
    'local / reviewer',
  )
  expect(host.querySelector('[data-testid="model-slots-status"]')?.textContent).toContain('new sessions')
  await choose(host, 'fast', '')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="model-slots-save"]')?.click())
  expect(host.querySelector('[data-testid="auto-review-slot-status"]')?.textContent).toContain('not set')
})
it('retains a rejected draft and disables writes without administrator permission', async () => {
  const host = await mount()
  await choose(host, 'verifier', JSON.stringify(['local', 'reviewer']))
  failSave = true
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="model-slots-save"]')?.click())
  expect(host.querySelector<HTMLSelectElement>('#model-slot-verifier')?.value).toBe(
    JSON.stringify(['local', 'reviewer']),
  )
  expect(host.querySelector('[data-testid="model-slots-status"]')?.getAttribute('role')).toBe('alert')
  await act(async () => root?.unmount())
  const readonly = await mount(false)
  expect(readonly.querySelector<HTMLSelectElement>('#model-slot-fast')?.disabled).toBe(true)
  expect(readonly.querySelector<HTMLButtonElement>('[data-testid="model-slots-save"]')?.disabled).toBe(true)
})
