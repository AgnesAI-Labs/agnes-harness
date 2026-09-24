import type { ConfigSnapshot, ConfigTestResult } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSettingsController } from '../src/settings.js'

// This suite's minimal fake DOM tests the controller. Real picker integration is covered by
// settings-accounts/settings-oauth; keyboard and dismissal behavior lives in provider-picker.test.
vi.mock('../src/provider-picker.js', () => ({
  createAccountPickers: () => ({ sync: vi.fn(), close: vi.fn() }),
}))

type FakeEvent = { preventDefault(): void }

class FakeElement {
  readonly tagName: string
  readonly id: string
  value = ''
  textContent = ''
  hidden = false
  disabled = false
  open = false
  isConnected = true
  children: FakeElement[] = []
  dataset: Record<string, string> = {}
  #listeners = new Map<string, Array<(event: FakeEvent) => void>>()

  constructor(tagName: string, id = '') {
    this.tagName = tagName.toUpperCase()
    this.id = id
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.#listeners.get(type) ?? []
    listeners.push(listener)
    this.#listeners.set(type, listeners)
  }

  dispatch(type: string): void {
    const event: FakeEvent = { preventDefault: () => undefined }
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = nodes
    if (this.tagName === 'SELECT') this.value = ''
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector === 'button' ? this.children.filter((child) => child.tagName === 'BUTTON') : []
  }

  setAttribute(name: string): void {
    if (name === 'open') this.open = true
  }

  removeAttribute(name: string): void {
    if (name === 'open') this.open = false
  }

  showModal(): void {
    this.open = true
  }

  close(): void {
    this.open = false
  }

  closest(): null {
    return null
  }

  focus(): void {
    fakeDocument.activeElement = this
  }
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>()
  activeElement: FakeElement | null = null

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName)
  }

  add(tagName: string, id: string): FakeElement {
    const node = new FakeElement(tagName, id)
    this.elements.set(id, node)
    return node
  }
}

let fakeDocument: FakeDocument
const originalDocument = globalThis.document

function installDom(): void {
  fakeDocument = new FakeDocument()
  fakeDocument.add('dialog', 'config')
  fakeDocument.add('form', 'config-form')
  fakeDocument.add('select', 'config-provider')
  fakeDocument.add('label', 'config-auth-method-field')
  fakeDocument.add('select', 'config-auth-method')
  fakeDocument.add('div', 'config-oauth-controls')
  fakeDocument.add('input', 'config-base-url')
  fakeDocument.add('input', 'config-api-key')
  fakeDocument.add('button', 'config-test')
  fakeDocument.add('select', 'config-model')
  fakeDocument.add('button', 'config-save')
  fakeDocument.add('p', 'config-error')
  fakeDocument.add('p', 'config-state')
  fakeDocument.add('div', 'config-accounts')
  fakeDocument.add('button', 'config-add-account')
  fakeDocument.add('button', 'config-retry')
  fakeDocument.add('p', 'config-key-hint')
  fakeDocument.add('button', 'config-close')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument })
}

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
  vi.restoreAllMocks()
})

function node(id: string): FakeElement {
  const found = fakeDocument.getElementById(id)
  if (!found) throw new Error(`missing fake element ${id}`)
  return found
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
    expect(node('config-add-account').disabled).toBe(true)
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
    expect(node('config-add-account').disabled).toBe(true)

    settings.setConnected(true)
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(node('config-accounts').dataset.state).toBe('empty'))
    expect(node('config-retry').hidden).toBe(true)
  })

  it('keeps the settings flow compatible with markup that lacks the optional key hint', async () => {
    installDom()
    fakeDocument.elements.delete('config-key-hint')
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
    const settings = createSettingsController({
      client: client(),
      onSaved: vi.fn(async () => undefined),
      onError: vi.fn(),
    })

    await settings.open()
    expect(node('config-state').textContent).toBe(
      '已加载保存的 Provider 与默认模型。测试连接后可更新默认模型；当前会话模型不会在此更改。',
    )
    expect(node('config-model').children[0]?.textContent).toBe('先测试 Provider，再选择默认模型')

    node('config-test').dispatch('click')
    await vi.waitFor(() => expect(node('config-model').children).toHaveLength(3))
    expect(node('config-state').textContent).toBe(
      '第 3 步：连接成功，发现 2 个模型。确认或选择默认模型后保存；当前会话模型不会改变。',
    )
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
    const returnFocus = fakeDocument.add('button', 'settings')
    fakeDocument.activeElement = returnFocus

    await settings.open()
    expect(node('config').open).toBe(true)
    expect(node('config-provider').value).toBe('deepseek')
    expect(node('config-base-url').value).toBe(provider.baseUrl)
    expect(node('config-api-key').value).toBe('')

    node('config-api-key').value = 'secret-value'
    node('config-api-key').dispatch('input')
    node('config-test').dispatch('click')
    await Promise.resolve()
    expect(node('config-state').textContent).toBe(
      '第 3 步：连接成功，发现 2 个模型。确认或选择默认模型后保存；当前会话模型不会改变。',
    )
    expect(node('config-api-key').value).toBe('secret-value')
    expect(node('config-model').children.map((entry) => entry.value)).toEqual([
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
    expect(node('config-state').textContent).toBe(
      '默认配置已保存；仅新建任务会使用新的默认模型，当前会话模型不会改变。',
    )
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
    expect(node('config-model').children.map((entry) => entry.value)).toEqual([''])
    expect(node('config-save').disabled).toBe(true)
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

  it('translates known configuration reasons into an actionable settings error', async () => {
    installDom()
    const onError = vi.fn()
    const settings = createSettingsController({
      client: client({
        test: async () => {
          throw {
            code: -32011,
            data: { code: 'SEMANTIC_REJECTED', reason: 'CONFIG_REVISION_CONFLICT' },
          }
        },
      }),
      onSaved: vi.fn(async () => undefined),
      onError,
    })
    await settings.open()
    node('config-test').dispatch('click')
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())

    expect(node('config-error').textContent).toBe('配置已被其他客户端修改，请重新打开设置后再试。')
    const reported = onError.mock.calls[0]?.[0]
    expect(reported).toBeInstanceOf(Error)
    expect((reported as Error).message).toBe('配置已被其他客户端修改，请重新打开设置后再试。')
  })

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
    expect(node('config-model').children.map((entry) => entry.value)).toEqual([''])
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
    expect(node('config-model').children.map((entry) => entry.value)).toEqual([''])
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
