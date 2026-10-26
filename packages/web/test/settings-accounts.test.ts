// @vitest-environment happy-dom

import type { ConfigAccount, ConfigSnapshot } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { createSettingsController } from '@agnes/web-admin/settings'
import { setLocaleTranslator } from '@agnes/web-foundation/locale-bridge'
import { unmountRegion } from '@agnes/web-ui'
import { Window } from 'happy-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { renderSettingsMarkup } from '../src/settings-region.js'
import { zhT } from './helpers/locale.js'

// i18n: these suites assert zh-CN catalog output; pin the translator before imports run.
setLocaleTranslator(zhT)

let window: Window | undefined
let disposeMarkup: (() => void) | undefined
afterEach(() => {
  for (const host of (window?.document.querySelectorAll(
    '#config-accounts, .agnes-ui-button-host, .agnes-ui-field-host',
  ) ?? []) as unknown as HTMLElement[])
    unmountRegion(host)
  disposeMarkup?.()
  disposeMarkup = undefined
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
  window?.happyDOM.abort()
  window = undefined
})
const account = (id: string): ConfigAccount => ({
  accountId: id,
  label: id,
  providerId: 'openai',
  route: `account-${id}`,
  baseUrl: `https://${id}.example/v1`,
  model: 'm',
  models: [
    {
      id: 'm',
      name: 'Model',
      reasoning: true,
      thinkingLevelMap: { low: 'low', high: 'high' },
      contextWindow: 128000,
      defaultSettings: { thinking: 'low', contextWindow: 64000 },
    },
  ],
  enabled: true,
  credentialConfigured: true,
  authType: 'api-key',
})
const OPENAI = {
  id: 'openai',
  label: 'OpenAI',
  api: 'openai-completions',
  baseUrl: 'https://api.openai.com/v1',
}
async function setup(
  accounts: ConfigAccount[] = [account('work'), account('personal')],
  providers = [OPENAI],
) {
  window = new Window()
  window.document.write('<!doctype html><html><head></head><body><dialog id="config"></dialog></body></html>')
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('window', window)
  vi.stubGlobal('getComputedStyle', window.getComputedStyle.bind(window))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({}, { status: 503 })),
  )
  disposeMarkup = renderSettingsMarkup(window.document.getElementById('config') as unknown as HTMLElement)
  const snapshot: ConfigSnapshot = {
    profile: 'local-dev',
    revision: 4,
    configured: true,
    provider: {
      id: 'openai',
      route: 'account-work',
      baseUrl: 'https://work.example/v1',
      model: 'm',
      credentialConfigured: true,
    },
    accounts,
    defaultAccountId: 'work',
    effect: 'new-sessions',
  }
  const config = {
    get: vi.fn(async () => snapshot),
    providers: vi.fn(async () => ({ providers })),
    test: vi.fn(async () => ({ verified: true, models: account('work').models })),
    save: vi.fn(async () => snapshot),
    account: vi.fn(
      async (): Promise<ConfigSnapshot> => ({ ...snapshot, revision: 5, defaultAccountId: 'personal' }),
    ),
  }
  const onSaved = vi.fn(async () => undefined)
  const onClose = vi.fn()
  const controller = createSettingsController({
    client: { config } as unknown as Client,
    onSaved,
    onError: vi.fn(),
    onClose,
  })
  await controller.open()
  const doc = window.document
  const input = (id: string) => doc.getElementById(id) as unknown as HTMLInputElement
  const click = async (selector: string) => {
    let node = doc.querySelector(selector)
    const action = /^button\[aria-label="(.+)"\]$/.exec(selector)?.[1]
    if (!node && action) {
      const label = action.split(' ').at(-1)
      const trigger = doc.querySelector(`button[aria-label="${label} 的操作"]`)
      ;(trigger as unknown as HTMLButtonElement | null)?.click()
      await vi.waitFor(() => expect(doc.querySelector('[role="menuitem"]')).not.toBeNull())
      node =
        [...doc.querySelectorAll('[role="menuitem"]')].find(
          (item) => item.textContent === action || item.getAttribute('aria-label') === action,
        ) ?? null
    }
    if (!node) throw new Error(`missing ${selector}`)
    ;(node as unknown as HTMLButtonElement).click()
    if (
      selector === '#account-dialog-close' &&
      !doc.getElementById('config-account-discard')?.hasAttribute('hidden')
    )
      (doc.getElementById('config-account-discard-confirm') as unknown as HTMLButtonElement)?.click()
  }
  return { config, controller, input, click, doc, onSaved, onClose }
}
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
it.each(['resolve', 'reject'] as const)(
  'ignores a test that %ss after the account draft is discarded',
  async (outcome) => {
    const h = await setup()
    await h.click('.config-account-select')
    let resolve!: (value: { verified: boolean; models: ConfigAccount['models'] }) => void
    let reject!: (reason: Error) => void
    const pending = {
      promise: new Promise<{ verified: boolean; models: ConfigAccount['models'] }>((yes, no) => {
        resolve = yes
        reject = no
      }),
    }
    h.config.test.mockReturnValueOnce(pending.promise)
    h.input('config-api-key').value = 'synthetic-discarded-key'
    await h.click('#config-test')
    expect(h.input('config-test').disabled).toBe(true)
    await h.click('#account-dialog-close')
    expect(h.input('config-api-key').value).toBe('')
    // Discard releases the account controls immediately; an old RPC need not finish first.
    expect(h.input('config-add-account').disabled).toBe(false)
    await h.click('button[aria-label="编辑 personal"]')
    h.input('config-api-key').value = 'synthetic-new-draft'
    if (outcome === 'reject') reject(new Error('Rejected synthetic-discarded-key'))
    else resolve({ verified: true, models: [{ id: 'stale-model', name: 'Stale model' }] })
    await settle()
    expect(h.doc.body.textContent).not.toContain('synthetic-discarded-key')
    expect(h.doc.querySelector('#config-model')?.textContent).not.toContain('Stale model')
    expect(h.input('config-api-key').value).toBe('synthetic-new-draft')
    expect(h.config.save).not.toHaveBeenCalled()
    h.controller.close()
  },
)
it('puts Agnes AI first in the Provider picker for a new account', async () => {
  const h = await setup()
  h.controller.close()
  h.config.providers.mockResolvedValue({
    providers: [
      { id: 'deepseek', label: 'DeepSeek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com' },
      { id: 'agnes-ai', label: 'Agnes AI', api: 'openai-completions', baseUrl: 'https://api.agnes-ai.cn/v1' },
      { id: 'openai', label: 'OpenAI', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1' },
    ],
  })
  await h.controller.open()
  await h.click('#config-add-account')
  expect(h.input('config-provider').value).toBe('agnes-ai')
  expect(h.input('config-base-url').value).toBe('https://api.agnes-ai.cn/v1')
  await h.click('#config-provider-trigger')
  expect(
    [...h.doc.querySelectorAll('[role="option"]')].map((option) => option.textContent?.replace('✓', '')),
  ).toEqual(['Agnes AI', 'DeepSeek', 'OpenAI'])
  await h.click('#account-dialog-close')
  await h.click('button[aria-label="编辑 personal"]')
  expect(h.input('config-provider').value).toBe('openai')
})

it('offers Agnes AI International as the Agnes provider at the international address', async () => {
  const agnes = {
    id: 'agnes-ai',
    label: 'Agnes AI',
    api: 'openai-completions',
    baseUrl: 'https://api.agnes-ai.cn/v1',
  }
  const h = await setup(undefined, [agnes, OPENAI])
  await h.click('#config-add-account')
  await h.click('[data-provider="agnes-ai:international"]')
  // Same provider and adapter; only the address and the suggested name follow the gateway.
  expect(h.input('config-provider').value).toBe('agnes-ai')
  expect(h.input('config-base-url').value).toBe('https://apihub.agnes-ai.com/v1')
  expect(h.input('config-account-name').value).toBe(zhT('accounts.agnesInternational'))
  expect(h.doc.getElementById('config-provider-host')?.textContent).toBe('apihub.agnes-ai.com/v1')
  h.controller.close()
})

it('uses the visible Provider picker to update connection fields and locks existing accounts', async () => {
  const h = await setup()
  h.controller.close()
  h.config.providers.mockResolvedValue({
    providers: [
      { id: 'openai', label: 'OpenAI', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1' },
      { id: 'deepseek', label: 'DeepSeek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com' },
    ],
  })
  await h.controller.open()
  await h.click('#config-add-account')
  h.input('config-api-key').value = 'transient-key'
  await h.click('#config-provider-trigger')
  await h.click('#config-provider-listbox-1')
  expect(h.input('config-provider').value).toBe('deepseek')
  expect(h.input('config-base-url').value).toBe('https://api.deepseek.com')
  expect(h.input('config-api-key').value).toBe('')
  expect(h.doc.querySelector('#config-provider-trigger')?.textContent).toBe('DeepSeek')
  expect(h.doc.querySelector('[role="listbox"]')).toBeNull()
  await h.click('#account-dialog-close')
  await h.click('button[aria-label="编辑 personal"]')
  expect(h.input('config-provider-trigger').disabled).toBe(true)
  expect(h.doc.querySelector('#config-provider-trigger')?.textContent).toBe('OpenAI')
  expect(h.config.save).not.toHaveBeenCalled()
})

it('colours the account indicator by enablement first, then credential health', async () => {
  const h = await setup([
    account('work'),
    { ...account('personal'), enabled: false },
    { ...account('broken'), credentialConfigured: false },
  ])
  const status = (index: number) =>
    h.doc.querySelectorAll('.config-account')[index]?.getAttribute('data-status')
  expect(status(0)).toBe('ready')
  expect(status(1)).toBe('inactive')
  expect(status(2)).toBe('missing')
  const broken = h.doc.querySelectorAll('.config-account')[2]
  if (!broken) throw new Error('missing unavailable account')
  expect(broken.textContent).toContain('需要重新填写 API key')
  const repair = [...broken.querySelectorAll('button')].find(
    (node) => node.textContent === '重新填写 API key',
  )
  if (!repair) throw new Error('missing key re-entry action')
  ;(repair as unknown as HTMLButtonElement).click()
  await vi.waitFor(() => expect(h.input('config-base-url').value).toBe('https://broken.example/v1'))
  expect(h.input('config-api-key').value).toBe('')
  h.input('config-api-key').value = 'test-enter-key'
  await h.click('#config-save')
  await vi.waitFor(() => expect(h.config.save).toHaveBeenCalled())
  expect(h.config.save).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: 'broken',
      apiKey: 'test-enter-key',
    }),
  )
  h.controller.close()
})

it('selects an exact account, clears transient keys and sends account-scoped test/save', async () => {
  const h = await setup()
  expect(h.doc.querySelectorAll('.config-account')).toHaveLength(2)
  expect(h.doc.querySelectorAll('.config-account-status')).toHaveLength(1)
  expect(h.doc.querySelector('button[aria-label="personal 的操作"]')).not.toBeNull()
  h.input('config-api-key').value = 'unsaved-secret'
  const personal = [...h.doc.querySelectorAll('.config-account-select')].find(
    (button) => button.textContent === 'personal',
  )
  if (!personal) throw new Error('Missing personal account action')
  ;(personal as unknown as HTMLButtonElement).click()
  expect(h.doc.querySelector('.config-account[data-selected=true] .config-account-select')?.textContent).toBe(
    'personal',
  )
  // Editing opens the account's page in the settings dialog, with the account form in it.
  await vi.waitFor(() =>
    expect(h.doc.querySelector('[data-testid="account-page-edit"] #config-api-key')).not.toBeNull(),
  )
  expect(h.doc.getElementById('config-detail-title')?.textContent).toBe('账户详情')
  expect(h.doc.getElementById('config-account-context')?.textContent).toBe('编辑连接与默认模型')
  expect(h.input('config-api-key').value).toBe('')
  expect(h.input('config-base-url').value).toBe('https://personal.example/v1')
  h.input('config-account-name').value = 'renamed personal'
  h.doc
    .getElementById('config-account-name')
    ?.dispatchEvent(new (window as Window).Event('input', { bubbles: true }))
  expect(h.input('config-save').disabled).toBe(false)
  h.input('config-account-name').value = 'personal'
  h.doc
    .getElementById('config-account-name')
    ?.dispatchEvent(new (window as Window).Event('input', { bubbles: true }))
  await h.click('#config-test')
  await settle()
  expect(h.config.test).toHaveBeenCalledWith({
    providerId: 'openai',
    accountId: 'personal',
    baseUrl: 'https://personal.example/v1',
  })
  h.input('config-model').value = 'm'
  expect(h.input('config-thinking').value).toBe('low')
  expect(h.input('config-context-window').value).toBe('64000')
  expect(
    [...h.doc.querySelectorAll('#config-thinking option')].map((option) => option.getAttribute('value')),
  ).toEqual(['', 'low', 'high'])
  h.input('config-thinking').value = 'high'
  h.input('config-context-window').value = '32K'
  h.doc
    .getElementById('config-form')
    ?.dispatchEvent(new (window as Window).Event('submit', { cancelable: true }))
  await settle()
  expect(h.config.save).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: 'personal',
      label: 'personal',
      expectedRevision: 4,
      defaultSettings: { thinking: 'high', contextWindow: 32000 },
    }),
  )
  expect(h.doc.body.textContent).not.toContain('unsaved-secret')
})
it('creates a distinct same-provider account and manages defaults with revision checks', async () => {
  const h = await setup()
  await h.click('button[aria-label="设为默认 personal"]')
  await settle()
  expect(h.config.account).toHaveBeenCalledWith({
    accountId: 'personal',
    action: 'default',
    expectedRevision: 4,
  })
  await h.click('#config-add-account')
  expect(h.input('config-account-name').value).toBe('OpenAI')
  expect(h.input('config-api-key').value).toBe('')
  await h.click('#config-save')
  expect(h.doc.querySelector('.account-dialog-body')?.getAttribute('data-account-step')).toBe('connection')
  h.input('config-account-name').value = 'New account'
  h.input('config-api-key').value = 'new-secret'
  await h.click('#config-test')
  await settle()
  expect(h.config.test).toHaveBeenLastCalledWith(
    expect.objectContaining({ accountId: expect.stringMatching(/^acct-/), apiKey: 'new-secret' }),
  )
  expect(h.input('config-model').value).toBe('m')
  expect(h.input('config-save').disabled).toBe(false)
  expect(h.input('config-model-trigger').disabled).toBe(false)
  await h.click('#config-model-trigger')
  await h.click('#config-model-listbox-0')
  expect(h.input('config-model').value).toBe('')
  expect(h.input('config-save').disabled).toBe(false)
  await h.click('#config-model-trigger')
  await h.click('#config-model-listbox-1')
  expect(h.input('config-model').value).toBe('m')
  expect(h.input('config-save').disabled).toBe(false)
  h.controller.setConnected(false)
  expect(h.input('config-api-key').value).toBe('')
  expect(h.input('config-test').disabled).toBe(true)
  expect(h.input('config-model-trigger').disabled).toBe(true)
})
it('requires an explicit second confirmation before removing an account', async () => {
  const h = await setup()
  await h.click('button[aria-label="删除 personal"]')
  expect(h.config.account).not.toHaveBeenCalled()
  await h.click('button[aria-label="确认删除 personal"]')
  await settle()
  expect(h.config.account).toHaveBeenCalledWith({
    accountId: 'personal',
    action: 'remove',
    expectedRevision: 4,
  })
})

it('names the provider, explains the locked model group and tells each error under its field', async () => {
  const h = await setup()
  const text = (id: string) => h.doc.getElementById(id)?.textContent
  const hidden = (id: string) => h.doc.getElementById(id)?.hasAttribute('hidden')
  const advanced = () => h.doc.getElementById('config-account-advanced')?.getAttribute('data-open')
  const change = (id: string, event = 'change') =>
    h.doc.getElementById(id)?.dispatchEvent(new (window as Window).Event(event, { bubbles: true }))
  // A new account names its provider and asks for a key; 换一个服务商 returns to the tiles.
  await h.click('#config-add-account')
  await h.click('[data-provider="openai"]')
  expect(text('config-provider-name')).toBe('OpenAI')
  expect(text('config-provider-host')).toBe('api.openai.com/v1')
  expect(h.input('config-api-key').placeholder).toBe(zhT('accounts.keyPlaceholderNew'))
  expect(text('config-model-lock')).toContain(zhT('accounts.modelLocked'))
  expect(hidden('config-model-lock')).toBe(false)
  await h.click('#config-provider-change')
  expect(h.doc.querySelector('.account-dialog-body')?.getAttribute('data-account-step')).toBe('provider')
  await h.click('#account-dialog-close')
  // Editing keeps the saved-key wording and offers a test from the locked group.
  await h.click('button[aria-label="编辑 personal"]')
  expect(h.input('config-api-key').placeholder).toBe(zhT('accounts.keyPlaceholder'))
  expect(hidden('config-provider-change')).toBe(true)
  await h.click('#config-model-lock-test')
  await settle()
  expect(text('config-state')).toBe(zhT('settings.step.third', { count: '1' }))
  expect(h.input('config-test').disabled).toBe(false)
  expect(hidden('config-model-lock')).toBe(true)
  // Closed advanced options show the values they hold.
  expect(
    [...h.doc.querySelectorAll('#config-account-advanced-meta .agnes-settings-tag')].map(
      (tag) => tag.textContent,
    ),
  ).toEqual([
    zhT('accounts.summaryName', { name: 'personal' }),
    zhT('accounts.summaryCustomUrl'),
    zhT('accounts.summaryTimeouts'),
  ])
  // A budget over the model's capacity is told under the budget, outside advanced options.
  h.input('config-context-window').value = '1M'
  change('config-context-window')
  expect(text('config-context-window-error')).toBe(zhT('accounts.overCapacity', { tokens: '128K' }))
  expect(h.input('config-context-window').getAttribute('aria-invalid')).toBe('true')
  expect(h.input('config-context-window').getAttribute('aria-describedby')).toContain(
    'config-context-window-error',
  )
  expect(text('config-error')).toBe('')
  expect(advanced()).toBe('false')
  h.input('config-context-window').value = ''
  change('config-context-window')
  expect(text('config-context-window-error')).toBe('')
  expect(h.input('config-context-window').getAttribute('aria-invalid')).not.toBe('true')
  // A missing name opens advanced options and puts the reader on the name.
  h.input('config-account-name').value = ' '
  change('config-account-name', 'input')
  change('config-form', 'submit')
  await settle()
  expect(h.config.save).not.toHaveBeenCalled()
  expect(advanced()).toBe('true')
  expect(h.doc.activeElement?.id).toBe('config-account-name')
  expect(text('config-account-name-error')).toBe(zhT('settings.account.nameRequired'))
  expect(h.input('config-account-name').getAttribute('aria-invalid')).toBe('true')
  expect(text('config-error')).toBe('')
  // The connection's own result is untouched by a field's error.
  expect(text('config-state')).toBe(zhT('settings.step.third', { count: '1' }))
  h.controller.close()
})

it('connects a relay through the OpenAI-compatible form: listed or typed models, no key needed', async () => {
  const compatible = {
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    api: 'openai-completions',
    baseUrl: 'https://endpoint.invalid/v1',
  }
  const h = await setup(undefined, [OPENAI, compatible])
  await h.click('#config-add-account')
  await h.click('[data-provider="preset:siliconflow"]')
  // The preset fills the address and the name; the address section opens; the key may stay empty.
  expect(h.input('config-provider').value).toBe('openai-compatible')
  expect(h.input('config-base-url').value).toBe('https://api.siliconflow.cn/v1')
  expect(h.input('config-account-name').value).toBe(zhT('accounts.preset.siliconflow'))
  expect(h.doc.getElementById('config-account-advanced')?.getAttribute('data-open')).toBe('true')
  expect(h.input('config-api-key').placeholder).toBe(zhT('accounts.keyOptional'))
  expect(h.doc.getElementById('config-key-hint')?.textContent).toBe(zhT('settings.key.optionalHint'))
  expect(h.doc.getElementById('config-provider-host')?.textContent).toBe('api.siliconflow.cn/v1')
  const panel = h.doc.getElementById('config-compatible-models') as HTMLElement | null
  expect(panel?.hidden).toBe(false)
  const fetchModels = () =>
    [...(panel?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent === zhT('accounts.compatible.fetch'))
      ?.click()
  // Entering an untouched relay reports missing configuration, never a rejected credential.
  h.config.test.mockResolvedValueOnce({
    models: [],
    verified: false,
    catalogueError: { reason: 'http', status: 401 },
  } as never)
  fetchModels()
  await vi.waitFor(() => expect(panel?.textContent).toContain('未配置'))
  expect(h.doc.getElementById('config-error')?.textContent).toBe('')
  expect(panel?.textContent).not.toContain('被拒')
  // A failed listing says why, and is not an error.
  h.config.test.mockResolvedValueOnce({
    models: [],
    verified: false,
    catalogueError: { reason: 'http', status: 404 },
  } as never)
  fetchModels()
  await vi.waitFor(() => expect(panel?.textContent).toContain(zhT('accounts.compatible.error.http404')))
  expect(h.config.test).toHaveBeenLastCalledWith({
    providerId: 'openai-compatible',
    accountId: expect.any(String),
    baseUrl: 'https://api.siliconflow.cn/v1',
  })
  expect(h.doc.getElementById('config-error')?.textContent).toBe('')
  // Listed models are picked by hand; the default model comes from the picked ones.
  const listed = (id: string) => ({ id, name: id, contextWindow: 32768, maxTokens: 8192 })
  h.config.test.mockResolvedValueOnce({ models: [listed('Qwen/Qwen3-32B'), listed('other')], verified: true })
  fetchModels()
  await vi.waitFor(() => expect(panel?.textContent).toContain('Qwen/Qwen3-32B'))
  expect(panel?.textContent).not.toContain(zhT('accounts.compatible.error.http404'))
  const chip = [...(panel?.querySelectorAll<HTMLButtonElement>('button[aria-pressed]') ?? [])].find(
    (button) => button.textContent === 'Qwen/Qwen3-32B',
  )
  chip?.click()
  await vi.waitFor(() => expect(h.input('config-model').value).toBe('Qwen/Qwen3-32B'))
  await h.click('#config-save')
  await vi.waitFor(() => expect(h.config.save).toHaveBeenCalled())
  const saved = h.config.save.mock.calls.at(-1) as unknown as [Record<string, unknown>]
  expect(saved[0]).toMatchObject({
    providerId: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    label: zhT('accounts.preset.siliconflow'),
    model: 'Qwen/Qwen3-32B',
    models: [listed('Qwen/Qwen3-32B')],
  })
  expect(saved[0]).not.toHaveProperty('apiKey')
  // Choosing it from the provider list (as the first-run guide does) opens the address too.
  await h.click('#config-add-account')
  await h.click('[data-provider="openai"]')
  const advancedOpen = () => h.doc.getElementById('config-account-advanced')?.getAttribute('data-open')
  expect(advancedOpen()).toBe('false')
  h.input('config-provider').value = 'openai-compatible'
  h.input('config-provider').dispatchEvent(
    new (window as Window).Event('change', { bubbles: true }) as unknown as Event,
  )
  expect(advancedOpen()).toBe('true')
  expect(h.input('config-base-url').value).toBe('')
  h.controller.close()
})

it('edits a saved OpenAI-compatible account: its models are part of the draft, a new address needs no key', async () => {
  const compatible = {
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    api: 'openai-completions',
    baseUrl: 'https://endpoint.invalid/v1',
  }
  const model = (id: string) => ({ id, name: id, contextWindow: 128000, maxTokens: 8192 })
  const relay: ConfigAccount = {
    ...account('relay'),
    providerId: 'openai-compatible',
    baseUrl: 'http://relay.example/v1',
    model: 'a',
    models: [model('a'), model('b')],
  }
  const h = await setup([relay], [OPENAI, compatible])
  const discardShown = () => !h.doc.getElementById('config-account-discard')?.hasAttribute('hidden')
  await h.click('button[aria-label="编辑 relay"]')
  const panel = h.doc.getElementById('config-compatible-models')
  await vi.waitFor(() => expect(panel?.querySelector('button[aria-label="Remove b"]')).not.toBeNull())
  // Dropping a model is a change worth confirming before it is thrown away.
  ;(
    h.doc.querySelector(
      '#config-compatible-models button[aria-label="Remove b"]',
    ) as unknown as HTMLButtonElement
  ).click()
  ;(h.doc.getElementById('account-dialog-close') as unknown as HTMLButtonElement).click()
  expect(discardShown()).toBe(true)
  ;(h.doc.getElementById('config-account-keep') as unknown as HTMLButtonElement).click()
  await h.click('#config-save')
  await vi.waitFor(() => expect(h.config.save).toHaveBeenCalled())
  const saved = h.config.save.mock.calls.at(-1) as unknown as [Record<string, unknown>]
  expect(saved[0]).toMatchObject({ models: [model('a')] })
  // A new address saves without a key; the backend decides whether a stored key may follow.
  await h.click('button[aria-label="编辑 relay"]')
  h.input('config-base-url').value = 'http://moved.example/v1'
  h.input('config-base-url').dispatchEvent(
    new (window as Window).Event('input', { bubbles: true }) as unknown as Event,
  )
  await vi.waitFor(() => expect(h.input('config-model').value).toBe('a'))
  expect(h.doc.getElementById('config-key-hint')?.textContent).toBe(zhT('settings.key.optionalHint'))
  await h.click('#config-save')
  await vi.waitFor(() => expect(h.config.save).toHaveBeenCalledTimes(2))
  const moved = h.config.save.mock.calls.at(-1) as unknown as [Record<string, unknown>]
  expect(moved[0]).toMatchObject({ baseUrl: 'http://moved.example/v1' })
  expect(moved[0]).not.toHaveProperty('apiKey')
  h.controller.close()
})

it('updates the empty state after saving the first account and removing the last one', async () => {
  const h = await setup([])
  expect(h.doc.getElementById('config-accounts')?.getAttribute('data-state')).toBe('empty')
  h.config.save.mockResolvedValue({ ...(await h.config.get()), revision: 5, accounts: [account('work')] })
  expect(h.doc.querySelector('.agnes-settings-page-header #config-add-account')).toBeNull()
  expect(h.doc.getElementById('config-add-account')).toBeNull()
  // Auxiliary models load independently; the account's empty state owns the connection guidance.
  expect(h.doc.querySelector('.config-accounts-welcome')?.textContent).toContain(zhT('accounts.empty'))
  const newSession = h.doc.createElement('button')
  newSession.id = 'new'
  const begin = vi.fn()
  newSession.addEventListener('click', begin)
  h.doc.body.append(newSession)
  await h.click('.config-accounts-demo button')
  expect(begin).toHaveBeenCalledOnce()
  await h.controller.open()
  await h.click('.config-accounts-welcome [data-provider="openai"]')
  expect(h.input('config-provider').value).toBe('openai')
  expect(h.doc.querySelector('.account-dialog-body')?.getAttribute('data-account-step')).toBe('connection')
  await h.click('#account-dialog-close')
  await h.click('.config-accounts-welcome [data-provider="more"]')
  expect(h.doc.querySelector('.account-dialog-body')?.getAttribute('data-account-step')).toBe('provider')
  await h.click('#config-save')
  h.input('config-account-name').value = 'work'
  h.input('config-api-key').value = 'synthetic-key'
  await h.click('#config-save')
  await vi.waitFor(() => expect(h.doc.querySelectorAll('.config-account')).toHaveLength(1))
  expect(h.doc.getElementById('config-accounts')?.getAttribute('data-state')).toBe('ready')
  expect(h.config.test).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'synthetic-key' }))
  expect(h.config.save).toHaveBeenCalledWith(expect.objectContaining({ model: 'm', expectedRevision: 4 }))
  expect(h.input('config-api-key').value).toBe('')
  h.config.account.mockResolvedValue({
    ...(await h.config.get()),
    revision: 6,
    accounts: [],
    defaultAccountId: null,
  })
  await h.click('button[aria-label="删除 work"]')
  await h.click('button[aria-label="确认删除 work"]')
  await vi.waitFor(() => expect(h.doc.querySelectorAll('.config-account')).toHaveLength(0))
  expect(h.doc.getElementById('config-accounts')?.getAttribute('data-state')).toBe('empty')
})

it('reuses the credential flow inline, preserves failed drafts and restores the account dialog on exit', async () => {
  const h = await setup([])
  const host = h.doc.createElement('div')
  h.doc.body.append(host)
  const detach = h.controller.attachInline(host as unknown as HTMLElement)
  await vi.waitFor(() => expect(h.input('config-account-name').value).toBe('OpenAI'))
  expect((h.doc.getElementById('config') as unknown as HTMLDialogElement).open).toBe(false)
  expect(host.querySelector('#config-api-key')).not.toBeNull()
  h.input('config-api-key').value = 'synthetic-private-key'
  h.config.test.mockRejectedValueOnce(new Error('Rejected synthetic-private-key'))
  expect(await h.controller.submitInline()).toBe(false)
  expect(h.config.save).not.toHaveBeenCalled()
  expect(h.input('config-api-key').value).toBe('synthetic-private-key')
  expect(h.doc.getElementById('config-error')?.textContent).not.toContain('synthetic-private-key')
  h.config.save.mockResolvedValue({ ...(await h.config.get()), revision: 5, accounts: [account('work')] })
  expect(await h.controller.submitInline()).toBe(true)
  expect(h.config.save).toHaveBeenCalledWith(
    expect.objectContaining({ label: 'OpenAI', model: 'm', expectedRevision: 4 }),
  )
  expect(h.input('config-api-key').value).toBe('')
  detach()
  expect(host.querySelector('#config-api-key')).toBeNull()
  expect(h.doc.querySelector('#account-dialog #config-api-key')).not.toBeNull()
  host.remove()
})

it('reports a close once per open dialog, however it was closed', async () => {
  const h = await setup()
  const dialog = h.doc.getElementById('config') as unknown as HTMLDialogElement
  expect(dialog.open).toBe(true)
  ;(h.doc.getElementById('config-close') as unknown as HTMLButtonElement).click()
  expect(dialog.open).toBe(false)
  expect(h.onClose).toHaveBeenCalledTimes(1)
  // Closing what is already closed is not a second close.
  h.controller.close()
  expect(h.onClose).toHaveBeenCalledTimes(1)
  await h.controller.open()
  dialog.dispatchEvent(new (window as Window).Event('cancel', { cancelable: true }) as unknown as Event)
  expect(h.onClose).toHaveBeenCalledTimes(2)
})
