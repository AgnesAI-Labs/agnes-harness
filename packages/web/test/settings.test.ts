import { installFeedbackSink, type OperationFeedback } from '@agnes/web-ui'
import { afterEach as feedbackAfterEach, beforeEach as feedbackBeforeEach } from 'vitest'
// @vitest-environment happy-dom

import type { ConfigSnapshot, ConfigTestResult } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { createSettingsController as createController } from '@agnes/web-admin/settings'
import { setLocaleTranslator } from '@agnes/web-foundation/locale-bridge'
import { unmountRegion } from '@agnes/web-ui'
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderSettingsMarkup } from '../src/settings-region.js'
import { zhT } from './helpers/locale.js'

// i18n: these suites assert zh-CN catalog output; pin the translator before imports run.
setLocaleTranslator(zhT)

// Picker interaction is covered by settings-accounts/settings-oauth; these cases exercise the
// controller against real DOM nodes because the account and select subtrees are React-owned.
vi.mock('@agnes/web-admin/provider-picker', () => ({
  createAccountPickers: () => ({ sync: vi.fn(), close: vi.fn() }),
}))

let fixtureWindow: Window
let disposeMarkup: (() => void) | undefined
// A controller left open keeps its typed-key auto test (a one-second debounce) armed. Its form looks
// its error line up in the global document, so a late timer would write into the next case's DOM.
const controllers: { close(): void }[] = []
const createSettingsController: typeof createController = (options) => {
  const controller = createController(options)
  controllers.push(controller)
  return controller
}

function installDom(): void {
  fixtureWindow = new Window()
  vi.stubGlobal('window', fixtureWindow)
  vi.stubGlobal('document', fixtureWindow.document)
  fixtureWindow.document.documentElement.lang = 'zh-CN'
  vi.stubGlobal('getComputedStyle', fixtureWindow.getComputedStyle.bind(fixtureWindow))
  fixtureWindow.document.body.innerHTML = '<dialog id="config"></dialog>'
  disposeMarkup = renderSettingsMarkup(
    fixtureWindow.document.getElementById('config') as unknown as HTMLElement,
  )
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.close()
  for (const host of (fixtureWindow?.document.querySelectorAll(
    '#config-accounts, .agnes-ui-button-host, .agnes-ui-field-host',
  ) ?? []) as unknown as HTMLElement[])
    unmountRegion(host)
  disposeMarkup?.()
  disposeMarkup = undefined
  fixtureWindow?.happyDOM.abort()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function node(
  id: string,
): HTMLElement & { value: string; disabled: boolean; open: boolean; dispatch(type: string): void } {
  const found = fixtureWindow.document.getElementById(id)
  if (!found) throw new Error(`missing fake element ${id}`)
  return Object.assign(found, {
    dispatch(type: string) {
      found.dispatchEvent(new fixtureWindow.Event(type, { bubbles: true, cancelable: true }))
    },
  }) as unknown as HTMLElement & {
    value: string
    disabled: boolean
    open: boolean
    dispatch(type: string): void
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const provider = {
  id: 'deepseek',
  label: 'DeepSeek',
  api: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com/v1',
}
const snapshot: ConfigSnapshot = {
  profile: 'local-dev',
  revision: 3,
  configured: true,
  provider: {
    id: provider.id,
    baseUrl: provider.baseUrl,
    model: 'deepseek-chat',
    credentialConfigured: true,
  },
  effect: 'new-sessions',
}
const testResult: ConfigTestResult = {
  verified: true,
  models: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ],
}

function client(
  overrides: Partial<{
    get: () => Promise<ConfigSnapshot>
    providers: () => Promise<{ providers: (typeof provider)[] }>
    test: (input: { providerId: string; baseUrl?: string; apiKey?: string }) => Promise<ConfigTestResult>
    save: (input: Record<string, unknown>) => Promise<ConfigSnapshot>
  }> = {},
): Client {
  return {
    config: {
      get: overrides.get ?? (async () => snapshot),
      providers: overrides.providers ?? (async () => ({ providers: [provider] })),
      test: overrides.test ?? (async () => testResult),
      save: overrides.save ?? (async () => snapshot),
    },
  } as unknown as Client
}

describe('settings controller', () => {
  it('renders translated account labels and hints without static locale markers', () => {
    installDom()
    expect(node('config-account-name').getAttribute('placeholder')).toBe('例如：工作账户、本地模型')
    expect(node('config-provider').previousElementSibling?.textContent).toBe('Provider')
    expect(node('config-thinking').previousElementSibling?.textContent).toBe('思考强度')
    expect(node('config-context-window').getAttribute('placeholder')).toBe('自动')
    expect(node('config-model-settings-hint').textContent).toContain('留空即自动')
    expect(fixtureWindow.document.querySelector('[data-i18n]')).toBeNull()
  })

  it('shows loading instead of the empty account copy while configuration is pending', async () => {
    installDom()
    const snapshotRequest = deferred<ConfigSnapshot>()
    const providersRequest = deferred<{ providers: (typeof provider)[] }>()
    const settings = createSettingsController({
      client: client({ get: () => snapshotRequest.promise, providers: () => providersRequest.promise }),
      onSaved: vi.fn(async () => undefined),
      onError: vi.fn(),
    })

    const opening = settings.open()

    expect(node('config-state').textContent).toBe('正在读取配置…')
    expect(fixtureWindow.document.getElementById('config-add-account')).toBeNull()
    expect(node('config-retry').hidden).toBe(true)

    snapshotRequest.resolve({ ...snapshot, accounts: [] })
    providersRequest.resolve({ providers: [provider] })
    await opening
  })

  it('shows empty only after a successful empty response', async () => {
    installDom()
    const settings = createSettingsController({
      client: client({ get: async () => ({ ...snapshot, accounts: [] }) }),
      onSaved: vi.fn(async () => undefined),
      onError: vi.fn(),
    })

    await settings.open()

    expect(node('config-accounts').dataset.state).toBe('empty')
  })

  it('shows a retry action after configuration loading fails', async () => {
    installDom()
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('配置请求失败'))
      .mockResolvedValue({ ...snapshot, accounts: [] })
    const settings = createSettingsController({
      client: client({ get }),
      onSaved: vi.fn(async () => undefined),
      onError: vi.fn(),
    })

    await settings.open()

    expect(node('config-retry').hidden).toBe(false)
    node('config-retry').dispatch('click')
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  })

  it('does not stay loading when opened offline and reloads after reconnecting', async () => {
    installDom()
    const get = vi.fn(async () => ({ ...snapshot, accounts: [] }))
    const settings = createSettingsController({
      client: client({ get }),
      onSaved: vi.fn(async () => undefined),
      onError: vi.fn(),
    })

    settings.setConnected(false)
    await settings.open()
    expect(node('config-state').textContent).toBe('配置读取失败，请重试。')
    expect(node('config-retry').hidden).toBe(false)
    expect(fixtureWindow.document.getElementById('config-add-account')).toBeNull()

    settings.setConnected(true)
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(node('config-accounts').dataset.state).toBe('empty'))
    expect(node('config-retry').hidden).toBe(true)
  })

  it('keeps the settings flow compatible with markup that lacks the optional key hint', async () => {
    installDom()
    node('config-key-hint').remove()
    const settings = createSettingsController({
      client: client(),
      onSaved: vi.fn(async () => undefined),
      onError: vi.fn(),
    })

    await settings.open()
    expect(node('config').open).toBe(true)
  })

  it('explains saved-key reuse without reading or revealing the credential', async () => {
    installDom()
    const settings = createSettingsController({
      client: client(),
      onSaved: vi.fn(async () => undefined),
      onError: vi.fn(),
    })

    await settings.open()

    expect(node('config-api-key').value).toBe('')
    expect(node('config-key-hint').textContent).toBe(
      '已保存 API key。留空会继续使用它；输入新值可替换。页面不会显示已保存的密钥。',
    )
    expect(node('config-key-hint').textContent).not.toContain('secret-value')
  })

  it('separates the saved default model from the current session model throughout configuration', async () => {
    installDom()
    const probe = vi.fn(async (): Promise<ConfigTestResult> => testResult)
    const settings = createSettingsController({
      client: client({ test: probe }),
      onSaved: vi.fn(async () => undefined),
      onError: vi.fn(),
    })

    await settings.open()
    // Nothing has happened yet, so the status line says nothing.
    expect(node('config-state').textContent).toBe('')
    expect(node('config-model').children[0]?.textContent).toBe('填入密钥后列出模型')

    node('config-test').dispatch('click')
    await vi.waitFor(() => expect(node('config-model').children).toHaveLength(3))
    expect(node('config-state').textContent).toBe('连接成功，找到 2 个模型')
    expect(node('config-state').dataset.tone).toBe('ok')
    node('config-api-key').value = 'fixture-key'
    for (const [reason, message] of [
      ['network', '连不上这个地址。'],
      ['timeout', '连接超时。'],
      ['invalid', '模型列表格式无法识别。'],
    ] as const) {
      probe.mockResolvedValueOnce({ models: [], verified: false, catalogueError: { reason } })
      node('config-test').dispatch('click')
      await vi.waitFor(() => expect(node('config-error').textContent).toBe(message))
      expect(node('config-error').textContent).not.toContain('被拒')
    }
    probe.mockResolvedValueOnce({ models: [], verified: false })
    node('config-test').dispatch('click')
    await vi.waitFor(() =>
      expect(node('config-error').textContent).toBe('无法确认凭据是否有效。服务未返回可用的对话模型列表。'),
    )
  })

  it('tests a key once typing settles, at once after a paste, and never a superseded one', async () => {
    installDom()
    const test = vi.fn(async (_input: { apiKey?: string }) => testResult)
    const onError = vi.fn()
    const settings = createSettingsController({
      client: client({ test }),
      onSaved: vi.fn(async () => undefined),
      onError,
    })
    await settings.open()
    vi.useFakeTimers()
    try {
      const key = node('config-api-key')
      key.value = 'half'
      key.dispatch('input')
      await vi.advanceTimersByTimeAsync(600)
      // Still typing: the earlier wait starts over, so a half-entered key is never sent.
      key.value = 'half-then-whole'
      key.dispatch('input')
      await vi.advanceTimersByTimeAsync(600)
      expect(test).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(400)
      expect(test).toHaveBeenCalledOnce()
      expect(test.mock.calls[0]?.[0]).toMatchObject({ apiKey: 'half-then-whole' })
      expect(node('config-state').textContent).toBe('连接成功，找到 2 个模型')
      // A changed key after a passed test says the earlier result no longer holds, then tests again.
      key.value = 'pasted-value'
      key.dispatch('paste')
      key.dispatch('input')
      expect(node('config-state').textContent).toBe('连接信息已变更，正在重新测试；此前的模型列表已失效。')
      await vi.advanceTimersByTimeAsync(0)
      expect(test).toHaveBeenCalledTimes(2)
      expect(test.mock.calls[1]?.[0]).toMatchObject({ apiKey: 'pasted-value' })
      // An emptied field has nothing to test.
      key.value = ''
      key.dispatch('input')
      await vi.advanceTimersByTimeAsync(2000)
      expect(test).toHaveBeenCalledTimes(2)
      // A failed automatic test reports on its own line, not as an app-level notice.
      test.mockRejectedValueOnce(new Error('The provider refused this key.'))
      key.value = 'refused-value'
      key.dispatch('input')
      await vi.advanceTimersByTimeAsync(1000)
      expect(node('config-error').textContent).toBe('The provider refused this key.')
      expect(onError).not.toHaveBeenCalled()
      node('config-test').dispatch('click')
      await vi.advanceTimersByTimeAsync(0)
      expect(test).toHaveBeenCalledTimes(4)
      expect(node('config-error').textContent).toBe('')
    } finally {
      vi.useRealTimers()
      settings.close()
    }
  })

  it('loads current revision, tests the selected provider, saves the model id, and clears the key', async () => {
    installDom()
    const save = vi.fn(async (_input: Record<string, unknown>) => ({
      ...snapshot,
      revision: 4,
      provider: snapshot.provider,
    }))
    const onSaved = vi.fn(async () => undefined)
    const settings = createSettingsController({ client: client({ save }), onSaved, onError: vi.fn() })
    const returnFocus = fixtureWindow.document.createElement('button')
    returnFocus.id = 'settings'
    fixtureWindow.document.body.append(returnFocus)
    returnFocus.focus()

    await settings.open()
    expect(node('config').open).toBe(true)
    expect(node('config-provider').value).toBe('deepseek')
    expect(node('config-base-url').value).toBe(provider.baseUrl)
    expect(node('config-api-key').value).toBe('')

    node('config-api-key').value = 'secret-value'
    node('config-api-key').dispatch('input')
    node('config-test').dispatch('click')
    await Promise.resolve()
    expect(node('config-state').textContent).toBe('连接成功，找到 2 个模型')
    expect(node('config-state').dataset.tone).toBe('ok')
    expect(node('config-api-key').value).toBe('secret-value')
    expect(Array.from(node('config-model').children, (entry) => (entry as HTMLOptionElement).value)).toEqual([
      '',
      'deepseek-chat',
      'deepseek-reasoner',
    ])
    node('config-model').value = 'deepseek-reasoner'
    node('config-model').dispatch('change')
    node('config-form').dispatch('submit')
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())

    expect(save.mock.calls[0]?.[0]).toMatchObject({
      providerId: 'deepseek',
      apiKey: 'secret-value',
      model: 'deepseek-reasoner',
      expectedRevision: 3,
    })
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(node('config-state').textContent).toBe('')
    expect(feedbackResults.at(-1)).toMatchObject({
      scope: 'model-accounts',
      outcome: 'success',
      effect: { kind: 'new-sessions' },
    })
    expect(node('config-api-key').value).toBe('')
    // 2026-09-17：账户详情改为独立弹窗后，保存只收起账户弹窗、留在设置里。
    expect(node('config').open).toBe(true)
    expect(returnFocus).toBeDefined()
  })

  it('invalidates in-flight test results when inputs change and prevents duplicate requests', async () => {
    installDom()
    const pending = deferred<ConfigTestResult>()
    const test = vi.fn(async () => pending.promise)
    const settings = createSettingsController({
      client: client({ test }),
      onSaved: vi.fn(async () => undefined),
      onError: vi.fn(),
    })
    await settings.open()
    node('config-api-key').value = 'temporary-secret'
    node('config-api-key').dispatch('input')
    node('config-test').dispatch('click')
    node('config-test').dispatch('click')
    expect(test).toHaveBeenCalledOnce()

    node('config-base-url').value = 'https://changed.example/v1'
    node('config-base-url').dispatch('input')
    pending.resolve(testResult)
    await Promise.resolve()
    await Promise.resolve()
    expect(Array.from(node('config-model').children, (entry) => (entry as HTMLOptionElement).value)).toEqual([
      '',
    ])
    expect(node('config-save').disabled).toBe(false)
  })

  it('redacts an entered key before reporting provider errors to the app', async () => {
    installDom()
    const onError = vi.fn()
    const settings = createSettingsController({
      client: client({
        test: async () => {
          throw new Error('provider rejected secret-value')
        },
      }),
      onSaved: vi.fn(async () => undefined),
      onError,
    })
    await settings.open()
    node('config-api-key').value = 'secret-value'
    node('config-api-key').dispatch('input')
    node('config-test').dispatch('click')
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())

    expect(node('config-error').textContent).toBe('provider rejected [redacted]')
    const reported = onError.mock.calls[0]?.[0]
    expect(reported).toBeInstanceOf(Error)
    expect((reported as Error).message).toBe('provider rejected [redacted]')
  })

  it.each([
    ['CONFIG_CREDENTIAL_PERMISSIONS', '无法保存凭据。 请检查存储权限。'],
    [
      'CONFIG_CREDENTIAL_PERMISSIONS',
      '无法保存凭据。 请检查存储权限。',
      { part: 'locks', check: 'mode', mode: '0644', expectedMode: '0600', path: '/private/do-not-render' },
    ],
    ['CONFIG_CREDENTIAL_READ_ONLY', '无法保存凭据。 请检查存储权限。'],
    ['CONFIG_CREDENTIAL_INVALID', '无法保存凭据。 请检查存储权限。'],
    ['CONFIG_CREDENTIAL_NO_SPACE', '无法保存凭据。 请检查存储权限。'],
    ['CONFIG_REVISION_CONFLICT', '资源已变更。 请重新载入最新状态后重试。'],
    ['CONFIG_CREDENTIAL_REJECTED', '凭据被拒绝。 请检查后重试。'],
    ['CONFIG_CREDENTIAL_REQUIRED', '缺少提供方凭据。 请为此提供方添加凭据。'],
  ])(
    'translates %s into an actionable settings error',
    async (reason, message, metadata: Record<string, unknown> = {}) => {
      installDom()
      const onError = vi.fn()
      const settings = createSettingsController({
        client: client({
          test: async () => {
            throw {
              code: -32011,
              data: { code: 'SEMANTIC_REJECTED', reason, ...metadata },
            }
          },
        }),
        onSaved: vi.fn(async () => undefined),
        onError,
      })
      await settings.open()
      node('config-test').dispatch('click')
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())

      expect(node('config-error').textContent).toBe(message)
      const reported = onError.mock.calls[0]?.[0]
      expect(reported).toBeInstanceOf(Error)
      expect((reported as Error).message).toBe(message)
      expect(node('config-error').textContent).not.toContain('/private/do-not-render')
    },
  )

  it('submits the provider default explicitly when replacing a saved custom endpoint', async () => {
    installDom()
    const customBaseUrl = 'https://gateway.example/v1'
    const configured = {
      ...snapshot,
      revision: 8,
      provider: {
        id: provider.id,
        model: 'deepseek-chat',
        credentialConfigured: true,
        baseUrl: customBaseUrl,
      },
    }
    const test = vi.fn(
      async (_input: { providerId: string; baseUrl?: string; apiKey?: string }) => testResult,
    )
    const save = vi.fn(async (_input: Record<string, unknown>) => snapshot)
    const settings = createSettingsController({
      client: client({ get: async () => configured, test, save }),
      onSaved: vi.fn(async () => undefined),
      onError: vi.fn(),
    })
    await settings.open()
    expect(node('config-base-url').value).toBe(customBaseUrl)
    node('config-base-url').value = provider.baseUrl
    node('config-base-url').dispatch('input')
    node('config-api-key').value = 'temporary-key'
    node('config-api-key').dispatch('input')
    node('config-test').dispatch('click')
    await vi.waitFor(() => expect(test).toHaveBeenCalledOnce())

    expect(test.mock.calls[0]?.[0]).toEqual({
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      apiKey: 'temporary-key',
    })
    node('config-model').value = 'deepseek-reasoner'
    node('config-model').dispatch('change')
    node('config-form').dispatch('submit')
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      apiKey: 'temporary-key',
      model: 'deepseek-reasoner',
      expectedRevision: 8,
    })
  })

  it('ignores late test results after close and never reopens or overwrites the dialog', async () => {
    installDom()
    const pending = deferred<ConfigTestResult>()
    const settings = createSettingsController({
      client: client({ test: async () => pending.promise }),
      onSaved: vi.fn(async () => undefined),
      onError: vi.fn(),
    })
    await settings.open()
    node('config-test').dispatch('click')
    settings.close()
    pending.resolve(testResult)
    await Promise.resolve()
    await Promise.resolve()
    expect(node('config').open).toBe(false)
    expect(Array.from(node('config-model').children, (entry) => (entry as HTMLOptionElement).value)).toEqual([
      '',
    ])
    expect(node('config-api-key').value).toBe('')
  })

  it('disables editing while disconnected and invalidates a pending test', async () => {
    installDom()
    const pending = deferred<ConfigTestResult>()
    const settings = createSettingsController({
      client: client({ test: async () => pending.promise }),
      onSaved: vi.fn(async () => undefined),
      onError: vi.fn(),
    })
    await settings.open()
    node('config-test').dispatch('click')
    settings.setConnected(false)
    expect(node('config-provider').disabled).toBe(true)
    expect(node('config-api-key').disabled).toBe(true)
    pending.resolve(testResult)
    await Promise.resolve()
    expect(Array.from(node('config-model').children, (entry) => (entry as HTMLOptionElement).value)).toEqual([
      '',
    ])
  })

  it('guards duplicate saves and refreshes the app after a late save without reopening the dialog', async () => {
    installDom()
    const pending = deferred<ConfigSnapshot>()
    const save = vi.fn(async () => pending.promise)
    const onSaved = vi.fn(async () => undefined)
    const settings = createSettingsController({ client: client({ save }), onSaved, onError: vi.fn() })
    await settings.open()
    node('config-api-key').value = 'one-shot-secret'
    node('config-api-key').dispatch('input')
    node('config-test').dispatch('click')
    await vi.waitFor(() => expect(node('config-model').children).toHaveLength(3))
    node('config-model').value = 'deepseek-chat'
    node('config-model').dispatch('change')
    node('config-form').dispatch('submit')
    node('config-form').dispatch('submit')
    expect(save).toHaveBeenCalledOnce()

    settings.close()
    pending.resolve(snapshot)
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(node('config').open).toBe(false)
    expect(node('config-api-key').value).toBe('')
  })
})

const feedbackResults: OperationFeedback[] = []
let releaseFeedback: (() => void) | undefined
feedbackBeforeEach(() => {
  feedbackResults.length = 0
  releaseFeedback = installFeedbackSink({ publish: (value) => feedbackResults.push(value), resolve() {} })
})
feedbackAfterEach(() => releaseFeedback?.())
