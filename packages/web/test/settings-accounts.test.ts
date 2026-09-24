import { readFileSync } from 'node:fs'
import type { ConfigAccount, ConfigSnapshot } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { Window } from 'happy-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { createSettingsController } from '../src/settings.js'
import { renderSettingsMarkup } from '../src/settings-region.js'

let window: Window | undefined
afterEach(() => {
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
  models: [{ id: 'm', name: 'Model' }],
  enabled: true,
  credentialConfigured: true,
  authType: 'api-key',
})
async function setup() {
  window = new Window()
  window.document.write(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'))
  renderSettingsMarkup(window.document.getElementById('config') as unknown as HTMLElement)
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('window', window)
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
    accounts: [account('work'), account('personal')],
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
    test: vi.fn(async () => ({ verified: true, models: [{ id: 'm', name: 'Model' }] })),
    save: vi.fn(async () => snapshot),
    account: vi.fn(async () => ({ ...snapshot, revision: 5, defaultAccountId: 'personal' })),
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
  const click = (selector: string) => {
    const node = doc.querySelector(selector)
    if (!node) throw new Error(`missing ${selector}`)
    ;(node as unknown as HTMLButtonElement).click()
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
  h.click('#config-add-account')
  expect(h.input('config-provider').value).toBe('agnes-ai')
  expect(h.input('config-base-url').value).toBe('https://api.agnes-ai.cn/v1')
  h.click('#config-provider-trigger')
  expect(
    [...h.doc.querySelectorAll('[role="option"]')].map((option) => option.textContent?.replace('✓', '')),
  ).toEqual(['Agnes AI', 'DeepSeek', 'OpenAI'])
  h.click('#account-dialog-close')
  h.click('button[aria-label="编辑 personal"]')
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
  h.click('#config-add-account')
  h.input('config-api-key').value = 'transient-key'
  h.click('#config-provider-trigger')
  h.click('#config-provider-listbox-1')
  expect(h.input('config-provider').value).toBe('deepseek')
  expect(h.input('config-base-url').value).toBe('https://api.deepseek.com')
  expect(h.input('config-api-key').value).toBe('')
  expect(h.doc.querySelector('#config-provider-trigger')?.textContent).toBe('DeepSeek')
  expect(h.doc.querySelector('[role="listbox"]')).toBeNull()
  h.click('#account-dialog-close')
  h.click('button[aria-label="编辑 personal"]')
  expect(h.input('config-provider-trigger').disabled).toBe(true)
  expect(h.doc.querySelector('#config-provider-trigger')?.textContent).toBe('OpenAI')
  expect(h.config.save).not.toHaveBeenCalled()
})

it('selects an exact account, clears transient keys and sends account-scoped test/save', async () => {
  const h = await setup()
  expect(h.doc.querySelectorAll('.config-account')).toHaveLength(2)
  expect(h.doc.querySelectorAll('.config-account-status')).toHaveLength(3)
  expect(h.doc.querySelector('button[aria-label="编辑 personal"]')).not.toBeNull()
  h.input('config-api-key').value = 'unsaved-secret'
  h.click('.config-account:nth-child(2) .config-account-select')
  expect((h.doc.getElementById('account-dialog') as unknown as HTMLDialogElement).open).toBe(true)
  expect(h.doc.getElementById('config-detail-title')?.textContent).toBe('账户详情')
  expect(h.doc.getElementById('config-account-context')?.textContent).toBe('编辑连接与默认模型')
  expect(h.input('config-api-key').value).toBe('')
  expect(h.input('config-base-url').value).toBe('https://personal.example/v1')
  h.click('#config-test')
  await settle()
  expect(h.config.test).toHaveBeenCalledWith({
    providerId: 'openai',
    accountId: 'personal',
    baseUrl: 'https://personal.example/v1',
  })
  h.input('config-model').value = 'm'
  h.doc
    .getElementById('config-form')
    ?.dispatchEvent(new (window as Window).Event('submit', { cancelable: true }))
  await settle()
  expect(h.config.save).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: 'personal', label: 'personal', expectedRevision: 4 }),
  )
  expect(h.doc.body.textContent).not.toContain('unsaved-secret')
})
it('creates a distinct same-provider account and manages defaults with revision checks', async () => {
  const h = await setup()
  h.click('button[aria-label="设为默认 personal"]')
  await settle()
  expect(h.config.account).toHaveBeenCalledWith({
    accountId: 'personal',
    action: 'default',
    expectedRevision: 4,
  })
  h.click('#config-add-account')
  expect(h.input('config-account-name').value).toBe('')
  expect(h.input('config-api-key').value).toBe('')
  h.input('config-account-name').value = 'New account'
  h.input('config-api-key').value = 'new-secret'
  h.click('#config-test')
  await settle()
  expect(h.config.test).toHaveBeenLastCalledWith(
    expect.objectContaining({ accountId: expect.stringMatching(/^acct-/), apiKey: 'new-secret' }),
  )
  expect(h.input('config-model').value).toBe('m')
  expect(h.input('config-save').disabled).toBe(false)
  expect(h.input('config-model-trigger').disabled).toBe(false)
  h.click('#config-model-trigger')
  h.click('#config-model-listbox-0')
  expect(h.input('config-model').value).toBe('')
  expect(h.input('config-save').disabled).toBe(true)
  h.click('#config-model-trigger')
  h.click('#config-model-listbox-1')
  expect(h.input('config-model').value).toBe('m')
  expect(h.input('config-save').disabled).toBe(false)
  h.controller.setConnected(false)
  expect(h.input('config-api-key').value).toBe('')
  expect(h.input('config-test').disabled).toBe(true)
  expect(h.input('config-model-trigger').disabled).toBe(true)
})
it('requires an explicit second confirmation before removing an account', async () => {
  const h = await setup()
  h.click('button[aria-label="删除 personal"]')
  expect(h.config.account).not.toHaveBeenCalled()
  h.click('button[aria-label="确认删除 personal"]')
  await settle()
  expect(h.config.account).toHaveBeenCalledWith({
    accountId: 'personal',
    action: 'remove',
    expectedRevision: 4,
  })
})
