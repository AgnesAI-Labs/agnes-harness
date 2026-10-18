/** @vitest-environment happy-dom */
import {
  createCatalogTranslator,
  createDocumentLocaleSource,
  installFeedbackSink,
  modelSettingsLocaleCatalog,
  type OperationFeedback,
  SettingsSubpageFrame,
  setAdvancedSettingsShown,
  UiLocaleProvider,
} from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PluginAdminApi } from '../src/admin/plugins/api.js'
import { AutoReviewPanel } from '../src/settings/auto-review.js'
import { reviewCatalog } from '../src/settings/auto-review-locale.js'
import { ModelSlotsPanel, modelSlotOptions, modelSlotsPanel } from '../src/settings/model-slots.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
const en = (key: string, vars?: Record<string, string | number>) =>
  (modelSettingsLocaleCatalog.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ''))
let state: {
  revision: number
  slots: Record<string, unknown>
  auto?: { fast?: { accountId: string; route: string; model: string } }
  canSave: boolean
  modelAdapters: {
    id: string
    version: string
    wireApi: string
    sourcePackage: string
    capabilities: { imageInput: boolean; tools: boolean; streaming: boolean }
    models: { route: string; id: string; label: string }[]
  }[]
} = {
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
const outcomes: OperationFeedback[] = []
let releaseFeedback: (() => void) | undefined
let releaseLocale: (() => void) | undefined
beforeEach(() => {
  outcomes.length = 0
  releaseFeedback = installFeedbackSink({ publish: (result) => outcomes.push(result), resolve() {} })
})
afterEach(async () => {
  releaseFeedback?.()
  releaseLocale?.()
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  writes.length = 0
  failSave = false
  delete state.auto
  setAdvancedSettingsShown(false)
})
async function mount(
  canSave = true,
  slots: Record<string, unknown> = {},
  optionsRead?: () => Promise<Response>,
  locale: 'en' | 'zh-CN' = 'en',
) {
  // Auxiliary models are an advanced fold: it exists only while advanced settings show.
  setAdvancedSettingsShown(true)
  state = { ...state, revision: 1, slots, canSave }
  vi.spyOn(PluginAdminApi, 'context').mockResolvedValue({} as never)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/admin/api/auto-review') return new Response(JSON.stringify({ modelSlot: 'fast' }))
      if (url === '/admin/api/model-adapters')
        return optionsRead ? optionsRead() : Response.json({ modelAdapters: state.modelAdapters })
      if (options?.method === 'POST') {
        writes.push(JSON.parse(String(options.body)))
        if (failSave) return new Response('{}', { status: 409 })
        state = { ...state, ...JSON.parse(String(options.body)), revision: state.revision + 1 }
      }
      const { modelAdapters: _options, ...snapshot } = state
      return Response.json(snapshot)
    }),
  )
  releaseLocale?.()
  document.documentElement.lang = locale
  const { source, dispose } = createDocumentLocaleSource({ '@agnes/web/auto-review': reviewCatalog })
  releaseLocale = dispose
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      createElement(
        UiLocaleProvider,
        { source },
        modelSlotsPanel({ accounts: [] }, createCatalogTranslator(modelSettingsLocaleCatalog, locale)),
        createElement(SettingsSubpageFrame, { header: null }, createElement(AutoReviewPanel, { canSave })),
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
it('saves each choice as it is made and refreshes the security card', async () => {
  const host = await mount()
  // The reviewer model is part of the auto review rules subpage.
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="auto-review-customize"]')?.click(),
  )
  expect(host.querySelector('[data-testid="auto-review-slot-status"]')?.textContent).toContain('not set')
  expect(host.querySelector('[data-testid="auto-review-model-link"]')?.getAttribute('href')).toBe(
    '?settings=model#auxiliary-models',
  )
  // No save or reload buttons: choosing is saving, at the revision the page read.
  expect(host.querySelector('[data-testid="model-slots-save"]')).toBeNull()
  expect(host.querySelector('[data-testid="model-slots-reload"]')).toBeNull()
  await choose(host, 'fast', JSON.stringify(['local', 'reviewer']))
  expect(writes).toEqual([{ revision: 1, slots: { fast: { route: 'local', model: 'reviewer' } } }])
  // Chosen: the warning goes, and the reviewer row names the model, not its route.
  expect(host.querySelector('[data-testid="auto-review-slot-status"]')).toBeNull()
  expect(host.querySelector('#auto-review-model option[value="fast"]')?.textContent).toContain('reviewer')
  expect(host.querySelector('[data-testid="model-slots-status"]')).toBeNull()
  expect(outcomes.at(-1)).toMatchObject({
    scope: 'model-slots',
    outcome: 'success',
    message: 'Model settings saved. New sessions use these settings.',
  })
  // Emptying the fast slot leaves it unset, so it follows the default account again.
  await choose(host, 'fast', '')
  expect(writes[1]).toEqual({ revision: 2, slots: {} })
  expect(host.querySelector('[data-testid="auto-review-slot-status"]')?.textContent).toContain('not set')
  // The verifier is only ever what was chosen: emptying it records that nothing verifies.
  await choose(host, 'verifier', JSON.stringify(['local', 'reviewer']))
  await choose(host, 'verifier', '')
  expect(writes[3]).toEqual({ revision: 4, slots: { verifier: null } })
})
it('says the settings changed elsewhere, keeps the choice and reloads on request', async () => {
  const host = await mount()
  failSave = true
  await choose(host, 'verifier', JSON.stringify(['local', 'reviewer']))
  expect(host.querySelector<HTMLSelectElement>('#model-slot-verifier')?.value).toBe(
    JSON.stringify(['local', 'reviewer']),
  )
  const status = host.querySelector('[data-testid="model-slots-status"]')
  expect(status?.getAttribute('role')).toBe('alert')
  expect(status?.textContent).toContain('Changed elsewhere')
  failSave = false
  // Someone else saved meanwhile: reloading shows what is saved now.
  state = { ...state, revision: 7, slots: { fast: { route: 'local', model: 'reviewer' } } }
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="model-slots-reload"]')?.click())
  expect(host.querySelector('[data-testid="model-slots-status"]')).toBeNull()
  expect(host.querySelector<HTMLSelectElement>('#model-slot-verifier')?.value).toBe('')
  expect(host.querySelector<HTMLSelectElement>('#model-slot-fast')?.value).toBe(
    JSON.stringify(['local', 'reviewer']),
  )
  await choose(host, 'verifier', JSON.stringify(['local', 'reviewer']))
  expect(writes.at(-1)).toMatchObject({ revision: 7 })
})
it.each(['en', 'zh-CN'] as const)(
  'shows checking availability until options load in %s, and refreshes auto review independently',
  async (locale) => {
    let resolveOptions!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveOptions = resolve
    })
    const target = { route: 'local', model: 'reviewer' }
    const host = await mount(
      true,
      { fast: target, verifier: target },
      () => pending.then((response) => response.clone()),
      locale,
    )
    const checking = locale === 'en' ? 'Checking availability' : '正在检查可用性'
    const unavailable = locale === 'en' ? 'Unavailable' : '不可用'
    const select = host.querySelector<HTMLSelectElement>('#model-slot-fast')!
    expect(select.value).toBe(JSON.stringify(['local', 'reviewer']))
    expect(select.disabled).toBe(false)
    expect(select.selectedOptions[0]?.textContent).toContain(checking)
    expect(host.querySelector('[data-testid="model-slot-fast-current"]')?.textContent).toContain(checking)
    expect(
      host.querySelector('[data-testid="auxiliary-models"] .agh-disclosure-meta')?.textContent,
    ).toContain(checking)
    expect(host.querySelector('[data-testid="auxiliary-models"]')?.textContent).not.toContain(unavailable)
    expect(host.querySelector('[data-testid="model-slots-options-loading"]')).not.toBeNull()
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="auto-review-customize"]')?.click(),
    )
    expect(host.querySelector('#auto-review-model option[value="fast"]')?.textContent).toContain(checking)
    expect(host.querySelector('[data-testid="auto-review-slot-status"]')).toBeNull()
    expect(host.querySelector('[data-testid="auto-review-options-loading"]')?.textContent).toContain(checking)
    // Clearing a saved value still works before options are available.
    await choose(host, 'verifier', '')
    expect(writes).toEqual([{ revision: 1, slots: { fast: target, verifier: null } }])
    // Only a completed catalog can establish that a saved model is absent.
    await act(async () => resolveOptions(Response.json({ modelAdapters: [] })))
    expect(select.selectedOptions[0]?.textContent).toContain(unavailable)
    expect(host.querySelector('#auto-review-model option[value="fast"]')?.textContent).toContain(unavailable)
    expect(host.querySelector('[data-testid="model-slot-fast-current"]')?.textContent).toContain(unavailable)
    expect(
      host.querySelector('[data-testid="auxiliary-models"] .agh-disclosure-meta')?.textContent,
    ).toContain(unavailable)
    expect(host.querySelector('[data-testid="auto-review-slot-status"]')?.textContent).toContain(
      locale === 'en' ? 'unavailable' : '不可用',
    )
    await choose(host, 'fast', '')
    expect(writes.at(-1)).toEqual({ revision: 2, slots: { verifier: null } })
    expect(select.value).toBe('')
    expect(host.querySelector('[data-testid="auto-review-slot-status"]')?.textContent).toContain(
      locale === 'en' ? 'not set' : '还没有设置',
    )
  },
)
it.each(['en', 'zh-CN'] as const)(
  'keeps an options failure separate from saved settings and retries the options in %s',
  async (locale) => {
    const optionsRead = vi.fn(async () => new Response('{}', { status: 502 }))
    const target = { route: 'local', model: 'reviewer' }
    const host = await mount(true, { fast: target, verifier: target }, optionsRead, locale)
    const unknown = locale === 'en' ? 'Availability unknown' : '可用性未知'
    expect(host.querySelector('[data-testid="model-slots-status"]')).toBeNull()
    expect(host.querySelector('[data-testid="model-slots-options-error"]')?.textContent).toContain(
      locale === 'en' ? 'Could not load model options' : '可选模型加载失败',
    )
    const select = host.querySelector<HTMLSelectElement>('#model-slot-verifier')!
    expect(select.value).toBe(JSON.stringify(['local', 'reviewer']))
    expect(select.selectedOptions[0]?.textContent).toContain(unknown)
    expect(
      host.querySelector('[data-testid="auxiliary-models"] .agh-disclosure-meta')?.textContent,
    ).toContain(unknown)
    expect(host.querySelector('[data-testid="model-slot-verifier-current"]')?.textContent).toContain(unknown)
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="auto-review-customize"]')?.click(),
    )
    expect(host.querySelector('#auto-review-model option[value="fast"]')?.textContent).toContain(unknown)
    expect(host.querySelector('[data-testid="auto-review-slot-status"]')).toBeNull()
    expect(host.querySelector('[data-testid="auto-review-options-error"]')?.textContent).toContain(unknown)
    expect(select.disabled).toBe(false)
    await choose(host, 'verifier', '')
    expect(writes).toEqual([{ revision: 1, slots: { fast: target, verifier: null } }])
    optionsRead.mockImplementation(async () => Response.json({ modelAdapters: state.modelAdapters }))
    const settingsReads = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => url === '/admin/api/model-slots').length
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="model-slots-options-error"] button')?.click(),
    )
    expect(host.querySelector('[data-testid="model-slots-options-error"]')).toBeNull()
    expect([...select.options].map((option) => option.value)).toContain(JSON.stringify(['local', 'reviewer']))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/admin/api/model-slots')).toHaveLength(
      settingsReads,
    )
    expect(host.querySelector('#model-slot-fast-trigger')?.textContent).not.toContain(unknown)
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="auto-review-options-error"] button')?.click(),
    )
    expect(host.querySelector('[data-testid="auto-review-options-error"]')).toBeNull()
    expect(host.querySelector('#auto-review-model option[value="fast"]')?.textContent).not.toContain(unknown)
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/admin/api/model-slots')).toHaveLength(
      settingsReads,
    )
  },
)
it('shows the model an unset fast slot follows, and nothing automatic for the verifier', async () => {
  state.auto = { fast: { accountId: 'account-1', route: 'local', model: 'reviewer' } }
  const host = await mount()
  const first = (slot: string) =>
    host.querySelector<HTMLSelectElement>(`#model-slot-${slot}`)?.options[0]?.textContent
  expect(first('fast')).toBe('Automatic · reviewer')
  expect(first('verifier')).toBe('Not set')
  expect(host.querySelector('[data-testid="auxiliary-models"] .agh-disclosure-meta')?.textContent).toBe(
    'Fast model Automatic · reviewer · Verifier model Not set',
  )
  // Without the backend's answer the slot reads as before.
  await act(async () => root?.unmount())
  delete state.auto
  expect((await mount()).querySelector<HTMLSelectElement>('#model-slot-fast')?.options[0]?.textContent).toBe(
    'Not set',
  )
  // A slot on a route no adapter serves any more reads as unavailable, not as a working choice.
  await act(async () => root?.unmount())
  const gone = await mount(true, { fast: { route: 'account-gone', model: 'reviewer' } })
  expect(gone.querySelector('[data-testid="auxiliary-models"] .agh-disclosure-meta')?.textContent).toBe(
    'Fast model reviewer · Unavailable · Verifier model Not set',
  )
})
it('is absent while advanced settings are off, and read-only without administrator permission', async () => {
  const readonly = await mount(false)
  expect(readonly.querySelector<HTMLSelectElement>('#model-slot-fast')?.disabled).toBe(true)
  await act(async () => setAdvancedSettingsShown(false))
  expect(readonly.querySelector('[data-testid="auxiliary-models"]')).toBeNull()
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
  setAdvancedSettingsShown(true)
  await act(async () => root?.render(createElement(ModelSlotsPanel, { t: en, accounts })))
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
it('offers no model of a payload-only adapter for a chat slot, and keeps a mixed adapter selectable', async () => {
  const adapter = (id: string, route: string, capabilities: Record<string, boolean>) => ({
    id,
    version: '1',
    wireApi: id,
    sourcePackage: 'local',
    capabilities: { imageInput: false, tools: false, streaming: false, ...capabilities },
    models: [{ route, id: `${id}-model`, label: id }],
  })
  const adapters = [
    adapter('chat', 'chat-route', { tools: true, streaming: true }),
    adapter('jev', 'jev-route', { payload: true, payloadOnly: true }),
    adapter('mixed', 'mixed-route', { payload: true }),
  ]
  // The catalog already leaves such models out; the picker does not rely on that alone.
  expect(modelSlotOptions({ ...state, modelAdapters: adapters }).map((option) => option.id)).toEqual([
    'chat-model',
    'mixed-model',
  ])
  state = { ...state, modelAdapters: adapters }
  const host = await mount()
  for (const slot of ['fast', 'verifier'])
    expect(
      [...host.querySelectorAll<HTMLOptionElement>(`#model-slot-${slot} option`)].map(
        (option) => option.value,
      ),
    ).toEqual([
      '',
      JSON.stringify(['chat-route', 'chat-model']),
      JSON.stringify(['mixed-route', 'mixed-model']),
    ])
})
