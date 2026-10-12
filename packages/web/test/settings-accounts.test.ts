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
async function setup(accounts: ConfigAccount[] = [account('work'), account('personal')]) {
  window = new Window()
  window.document.write('<!doctype html><html><head></head><body><dialog id="config"></dialog></body></html>')
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('window', window)
  vi.stubGlobal('getComputedStyle', window.getComputedStyle.bind(window))
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
    providers: vi.fn(async () => ({
      providers: [
        { id: 'openai', label: 'OpenAI', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1' },
      ],
    })),
    test: vi.fn(async () => ({ verified: true, models: account('work').models })),
    save: vi.fn(async () => snapshot),
    account: vi.fn(
      async (): Promise<ConfigSnapshot> => ({ ...snapshot, revision: 5, defaultAccountId: 'personal' }),
    ),
  }
  const onSaved = vi.fn(async () => undefined)
  const controller = createSettingsController({
    client: { config } as unknown as Client,
    onSaved,
    onError: vi.fn(),
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
        [...doc.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === action) ?? null
    }
    if (!node) throw new Error(`missing ${selector}`)
    ;(node as unknown as HTMLButtonElement).click()
    if (
      selector === '#account-dialog-close' &&
      !doc.getElementById('config-account-discard')?.hasAttribute('hidden')
    )
      (doc.getElementById('config-account-discard-confirm') as unknown as HTMLButtonElement)?.click()
  }
  return { config, controller, input, click, doc, onSaved }
}
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
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
  expect((h.doc.getElementById('account-dialog') as unknown as HTMLDialogElement).open).toBe(true)
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

it('updates the empty state after saving the first account and removing the last one', async () => {
  const h = await setup([])
  expect(h.doc.getElementById('config-accounts')?.getAttribute('data-state')).toBe('empty')
  h.config.save.mockResolvedValue({ ...(await h.config.get()), revision: 5, accounts: [account('work')] })
  await h.click('#config-add-account')
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
