import { readFileSync } from 'node:fs'
import type { ConfigOAuthInput, ConfigOAuthPrompt, ConfigProvider, ConfigSnapshot } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { unmountRegion } from '@agnes/web-ui'
import { type HTMLButtonElement as HappyButton, type HTMLLabelElement as HappyLabel, Window } from 'happy-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { createSettingsController, type SettingsController } from '../src/settings.js'
import { renderSettingsMarkup } from '../src/settings-region.js'

function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('missing fixture element')
  return value
}
let window: Window | undefined
let activeController: SettingsController | undefined
let disposeMarkup: (() => void) | undefined
afterEach(async () => {
  activeController?.close()
  for (const host of (window?.document.querySelectorAll(
    '#config-accounts, .agnes-ui-button-host, .agnes-ui-field-host',
  ) ?? []) as unknown as HTMLElement[])
    unmountRegion(host)
  disposeMarkup?.()
  disposeMarkup = undefined
  activeController = undefined
  vi.unstubAllGlobals()
  await window?.happyDOM.abort()
  window = undefined
})

async function setup(
  options: {
    provider?: ConfigProvider
    providers?: ConfigProvider[]
    prompt?: ConfigOAuthPrompt
    snapshot?: ConfigSnapshot
  } = {},
) {
  window = new Window()
  window.document.write(
    readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(
      /<link rel="stylesheet" href="\/(?:style|antd|tokens)\.css" \/>/g,
      '',
    ),
  )
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('window', window)
  vi.stubGlobal('getComputedStyle', window.getComputedStyle.bind(window))
  disposeMarkup = renderSettingsMarkup(window.document.getElementById('config') as unknown as HTMLElement)
  const snapshot: ConfigSnapshot = options.snapshot ?? {
    profile: 'local-dev',
    revision: 0,
    configured: false,
    provider: null,
    accounts: [],
    defaultAccountId: null,
    effect: 'new-sessions',
  }
  const provider =
    options.provider ??
    ({
      id: 'openai-codex',
      label: 'OpenAI Codex',
      authType: 'oauth',
      authMethods: ['oauth'],
      loginMethods: ['browser', 'device_code'],
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
    } satisfies ConfigProvider)
  const loginHosts: Record<string, string> = {
    'openai-codex': 'auth.openai.com',
    anthropic: 'claude.ai',
    'github-copilot': 'github.com',
    'kimi-coding': 'www.kimi.com',
    xai: 'accounts.x.ai',
  }
  let ready = false
  const oauth = vi.fn(async (input: ConfigOAuthInput) => {
    if (input.action === 'commit')
      return { operationId: 'op', state: 'saved', snapshot: { ...snapshot, revision: 1 } }
    if (input.action === 'cancel') return { operationId: 'op', state: 'cancelled' }
    if (ready) return { operationId: 'op', state: 'ready', models: [{ id: 'gpt-codex', name: 'Codex' }] }
    return {
      operationId: 'op',
      state: 'running',
      notices: [
        { message: `${provider.label} 登录`, url: `https://${loginHosts[provider.id]}/oauth/authorize` },
      ],
      prompt: options.prompt ?? { id: 'prompt', message: 'code', type: 'manual_code' },
    }
  })
  const save = vi.fn(),
    onSaved = vi.fn()
  const client = {
    config: {
      get: async () => snapshot,
      providers: async () => ({
        providers: options.providers ?? [provider],
      }),
      oauth,
      test: vi.fn(async () => ({ models: snapshot.accounts?.[0]?.models ?? [], verified: true })),
      save,
    },
  } as unknown as Client
  const controller = createSettingsController({ client, onSaved, onError: () => {} })
  activeController = controller
  await controller.open()
  const doc = window.document
  if (options.snapshot)
    must([...doc.querySelectorAll('button')].find((b) => b.textContent === '编辑')).click()
  else must(doc.querySelector<HappyButton>('#config-add-account')).click()
  expect((doc.getElementById('config-provider') as unknown as HTMLSelectElement).value).not.toBe('')
  ;(doc.getElementById('config-account-name') as unknown as HTMLInputElement).value = 'Work account'
  const panel = must(doc.querySelector('section[aria-label="订阅登录"]'))
  expect(panel.closest('#account-dialog')).not.toBeNull()
  const button = (label: string) =>
    must([...panel.querySelectorAll('button')].find((b) => b.textContent === label))
  return {
    doc,
    panel,
    button,
    controller,
    oauth,
    save,
    onSaved,
    test: client.config.test,
    ready: () => {
      ready = true
    },
  }
}

it.each(['resolve', 'reject'] as const)(
  'ignores an old test %s after cancellation and a new login',
  async (outcome) => {
    const h = await setup()
    h.ready()
    h.button('浏览器登录').click()
    const testButton = must(h.doc.querySelector<HappyButton>('#config-test'))
    await vi.waitFor(() => expect(testButton.disabled).toBe(false))
    let complete!: () => void
    const original = must(h.oauth.getMockImplementation())
    h.oauth.mockImplementation((input) => {
      if (input.action === 'test')
        return new Promise((resolve, reject) => {
          complete = () =>
            outcome === 'resolve'
              ? resolve({ operationId: 'op', state: 'ready' } as never)
              : reject(new Error('old test failed'))
        })
      if (input.action === 'start' || input.action === 'poll')
        return Promise.resolve({ operationId: 'new-op', state: 'running' } as never)
      return original(input)
    })
    testButton.click()
    await vi.waitFor(() => expect(complete).toBeDefined())
    h.button('取消登录').click()
    await vi.waitFor(() => expect(h.button('浏览器登录').disabled).toBe(false))
    h.button('浏览器登录').click()
    await vi.waitFor(() => expect(h.button('浏览器登录').disabled).toBe(true))
    complete()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.doc.getElementById('config-error')?.textContent).toBe('')
    expect(h.doc.getElementById('config-state')?.textContent).not.toContain('测试通过')
    expect(h.button('浏览器登录').disabled).toBe(true)
    expect(testButton.disabled).toBe(true)
    h.controller.close()
  },
)

it('allows replacing an unavailable saved OAuth model and revalidates each selection', async () => {
  const models = [
    { id: 'retired', name: 'Retired' },
    { id: 'working', name: 'Working' },
  ]
  const h = await setup({
    snapshot: {
      profile: 'local-dev',
      revision: 1,
      configured: true,
      provider: null,
      defaultAccountId: 'work',
      effect: 'new-sessions',
      accounts: [
        {
          accountId: 'work',
          label: 'Work',
          providerId: 'openai-codex',
          route: 'account-work',
          baseUrl: 'https://chatgpt.com/backend-api',
          model: 'retired',
          models,
          enabled: true,
          credentialConfigured: true,
          authType: 'oauth',
        },
      ],
    },
  })
  const select = must(h.doc.querySelector('#config-model')) as unknown as HTMLSelectElement
  const testButton = must(h.doc.querySelector<HappyButton>('#config-test'))
  const saveButton = must(h.doc.querySelector<HappyButton>('#config-save'))
  expect(select.disabled).toBe(false)
  expect(saveButton.disabled).toBe(true)
  vi.mocked(h.test).mockRejectedValueOnce(new Error('CONFIG_SUBSCRIPTION_MODEL'))
  testButton.click()
  await vi.waitFor(() => expect(h.doc.getElementById('config-error')?.textContent).not.toBe(''))
  expect(select.disabled).toBe(false)
  select.value = 'working'
  select.dispatchEvent(new (must(window).Event)('change') as unknown as Event)
  testButton.click()
  await vi.waitFor(() => expect(saveButton.disabled).toBe(false))
  expect(h.test).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'working', accountId: 'work' }))
  expect(select.value).toBe('working')
  select.value = 'retired'
  select.dispatchEvent(new (must(window).Event)('change') as unknown as Event)
  expect(saveButton.disabled).toBe(true)
  h.controller.close()
})

it('offers subscription controls, keeps polling during manual input and commits the selected model', async () => {
  const h = await setup()
  const keyLabel = must(h.doc.getElementById('config-api-key')).closest('label') as HappyLabel | null
  expect(keyLabel?.hidden).toBe(true)
  expect((h.doc.getElementById('config-base-url') as unknown as HTMLInputElement).disabled).toBe(true)
  h.button('浏览器登录').click()
  await vi.waitFor(() => expect(h.panel.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer'))
  expect(must(h.panel.querySelector('label')).hidden).toBe(false)
  h.ready()
  await vi.waitFor(() => expect(must(h.panel.querySelector('label')).hidden).toBe(true))
  expect(h.panel.textContent).toContain('保存前会发送一条测试请求')
  const model = h.doc.getElementById('config-model') as unknown as HTMLSelectElement
  model.value = 'gpt-codex'
  must(h.doc.getElementById('config-form')).dispatchEvent(
    new (must(window).Event)('submit', { cancelable: true }),
  )
  await vi.waitFor(() => expect(h.onSaved).toHaveBeenCalled())
  expect(h.oauth).toHaveBeenCalledWith({ action: 'commit', operationId: 'op', model: 'gpt-codex' })
  expect(h.save).not.toHaveBeenCalled()
  h.controller.close()
})

it('uses the Provider label when a new account starts login with an empty name', async () => {
  const h = await setup()
  const name = h.doc.getElementById('config-account-name') as unknown as HTMLInputElement
  name.value = ''
  h.button('浏览器登录').click()
  await vi.waitFor(() =>
    expect(h.oauth).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'start',
        providerId: 'openai-codex',
        label: 'OpenAI Codex',
      }),
    ),
  )
  expect(name.value).toBe('OpenAI Codex')
  h.controller.close()
})

it('enables a separate subscription model test after authorization without saving the account', async () => {
  const h = await setup()
  h.button('浏览器登录').click()
  await vi.waitFor(() => expect(h.oauth).toHaveBeenCalled())
  h.ready()
  const test = must(h.doc.querySelector<HappyButton>('#config-test'))
  await vi.waitFor(() => expect(test.disabled).toBe(false))
  test.click()
  await vi.waitFor(() =>
    expect(h.oauth).toHaveBeenCalledWith({ action: 'test', operationId: 'op', model: 'gpt-codex' }),
  )
  await vi.waitFor(() => expect(h.doc.getElementById('config-state')?.textContent).toContain('测试通过'))
  expect(h.onSaved).not.toHaveBeenCalled()
  expect(h.save).not.toHaveBeenCalled()
  expect(h.oauth.mock.calls.some(([input]) => input.action === 'commit')).toBe(false)
  h.oauth.mockRejectedValueOnce({ data: { reason: 'CONFIG_SUBSCRIPTION_QUOTA' } })
  test.click()
  await vi.waitFor(() => expect(h.doc.getElementById('config-error')?.textContent).toContain('额度'))
  expect(test.disabled).toBe(false)
  expect((h.doc.getElementById('config-model') as unknown as HTMLSelectElement).value).toBe('gpt-codex')
  h.controller.close()
})

it('closing the account dialog cancels login and stale replies cannot enable saving', async () => {
  const h = await setup()
  h.button('设备码登录').click()
  await vi.waitFor(() => expect(h.oauth).toHaveBeenCalled())
  must(h.doc.querySelector<HappyButton>('#account-dialog-close')).click()
  await vi.waitFor(() => expect(h.oauth).toHaveBeenCalledWith({ action: 'cancel', operationId: 'op' }))
  h.ready()
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect((h.doc.getElementById('config-save') as unknown as HTMLButtonElement).disabled).toBe(true)
  expect(h.onSaved).not.toHaveBeenCalled()
  h.controller.close()
})

it('keeps dual-auth controls in the modal and exposes only the provider-supported login method', async () => {
  const h = await setup({
    provider: {
      id: 'kimi-coding',
      label: 'Kimi Code',
      authMethods: ['api-key', 'oauth'],
      loginMethods: ['device_code'],
      api: 'anthropic-messages',
      baseUrl: 'https://api.kimi.com/coding',
    },
  })
  expect((h.panel as unknown as HTMLElement).hidden).toBe(true)
  const auth = h.doc.getElementById('config-auth-method') as unknown as HTMLSelectElement
  auth.value = 'oauth'
  auth.dispatchEvent(new (must(window).Event)('change') as unknown as Event)
  expect((h.panel as unknown as HTMLElement).hidden).toBe(false)
  expect(h.button('浏览器登录').hidden).toBe(true)
  expect(h.button('设备码登录').hidden).toBe(false)
  h.button('设备码登录').click()
  await vi.waitFor(() =>
    expect(h.oauth).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'start', providerId: 'kimi-coding', loginMethod: 'device_code' }),
    ),
  )
  h.controller.close()
})

it('submits a blank Copilot enterprise prompt and keeps focus inside the account dialog', async () => {
  const h = await setup({
    provider: {
      id: 'github-copilot',
      label: 'GitHub Copilot',
      authType: 'oauth',
      authMethods: ['oauth'],
      loginMethods: ['device_code'],
      api: 'openai-responses',
      baseUrl: 'https://api.individual.githubcopilot.com',
    },
    prompt: {
      id: 'enterprise',
      message: 'Enterprise domain (blank for github.com)',
      type: 'text',
      placeholder: 'github.example.com',
    },
  })
  h.button('设备码登录').click()
  const input = must(h.panel.querySelector('input'))
  await vi.waitFor(() => expect((must(input.closest('label')) as unknown as HTMLElement).hidden).toBe(false))
  expect(h.doc.activeElement).toBe(input)
  h.ready()
  h.button('继续').click()
  await vi.waitFor(() =>
    expect(h.oauth).toHaveBeenCalledWith({
      action: 'answer',
      operationId: 'op',
      promptId: 'enterprise',
      answer: '',
    }),
  )
  expect(input.closest('#account-dialog')).not.toBeNull()
  h.controller.close()
})

it('lists five explicit subscription entries and starts the selected dual-auth provider directly', async () => {
  const providers: ConfigProvider[] = [
    'openai-codex',
    'anthropic',
    'github-copilot',
    'kimi-coding',
    'xai',
  ].map((id) => ({
    id,
    label: id,
    api: 'test',
    baseUrl: 'https://example.test',
    authType: ['openai-codex', 'github-copilot'].includes(id) ? 'oauth' : 'api-key',
    authMethods: ['openai-codex', 'github-copilot'].includes(id) ? ['oauth'] : ['api-key', 'oauth'],
    loginMethods: id === 'anthropic' ? ['browser'] : ['device_code'],
  }))
  const h = await setup({ providers })
  const group = must(h.doc.querySelector('optgroup[label="订阅登录"]'))
  expect(group.querySelectorAll('option')).toHaveLength(5)
  const select = h.doc.getElementById('config-provider') as unknown as HTMLSelectElement
  select.value = 'kimi-coding:oauth'
  select.dispatchEvent(new (must(window).Event)('change') as unknown as Event)
  expect((h.panel as unknown as HTMLElement).hidden).toBe(false)
  h.button('设备码登录').click()
  await vi.waitFor(() =>
    expect(h.oauth).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'start', providerId: 'kimi-coding' }),
    ),
  )
  h.controller.close()
})

it('resets failed login controls and clears the error before retrying', async () => {
  const h = await setup()
  h.oauth.mockRejectedValueOnce(new Error('CONFIG_AUTH_FAILED'))
  h.button('浏览器登录').click()
  await vi.waitFor(() => expect(h.doc.getElementById('config-error')?.textContent).toContain('登录失败'))
  expect(h.button('浏览器登录').disabled).toBe(false)
  expect(h.button('取消登录').hidden).toBe(true)
  expect(h.panel.textContent).not.toContain('等待授权')
  h.button('浏览器登录').click()
  await vi.waitFor(() => expect(h.panel.querySelector('a')).not.toBeNull())
  expect(h.doc.getElementById('config-error')?.textContent).toBe('')
  h.controller.close()
})
