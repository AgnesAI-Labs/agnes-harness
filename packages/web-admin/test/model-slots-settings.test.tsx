/** @vitest-environment happy-dom */
import { modelSettingsLocaleCatalog } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginAdminApi } from '../src/admin/plugins/api.js'
import { AutoReviewPanel } from '../src/settings/auto-review.js'
import { ModelSlotsPanel, modelSlotOptions } from '../src/settings/model-slots.js'

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
      wireApi: 'scripted',
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
it('names each model by its account and display name, and picks through the themed picker', async () => {
  const route = 'account-acct-1192aece-ff60-4c1e-9d0b-000000000001'
  const adapters = [
    { ...state.modelAdapters[0]!, models: [{ route, id: 'deepseek-v4-flash', label: 'deepseek' }] },
  ]
  const accounts = [
    { route, label: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4.1 Flash' }] },
  ]
  // The internal route stays the value; what is read is the account and the model's own name.
  expect(modelSlotOptions({ ...state, modelAdapters: adapters }, accounts)).toEqual([
    { route, id: 'deepseek-v4-flash', label: 'DeepSeek', name: 'DeepSeek V4.1 Flash' },
  ])
  // Without a matching account the catalogue's own label is the fallback.
  expect(modelSlotOptions({ ...state, modelAdapters: adapters })[0]?.label).toBe('deepseek')
  state = { ...state, modelAdapters: adapters }
  vi.spyOn(PluginAdminApi, 'context').mockResolvedValue({} as never)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(state))),
  )
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      createElement(ModelSlotsPanel, { t: (key) => modelSettingsLocaleCatalog.en[key] ?? key, accounts }),
    ),
  )
  const select = host.querySelector<HTMLSelectElement>('#model-slot-fast')!
  const labels = [...select.options].map((option) => option.textContent)
  expect(labels).toContain('DeepSeek · DeepSeek V4.1 Flash')
  expect(labels.join(' ')).not.toContain('account-acct')
  // The native control is hidden behind the themed trigger, which shows the current choice.
  expect(select.hidden).toBe(true)
  const trigger = host.querySelector<HTMLButtonElement>('#model-slot-fast-trigger')!
  expect(trigger.getAttribute('role')).toBe('combobox')
  await choose(host, 'fast', JSON.stringify([route, 'deepseek-v4-flash']))
  expect(trigger.textContent).toContain('DeepSeek · DeepSeek V4.1 Flash')
})
