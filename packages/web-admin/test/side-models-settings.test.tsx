/** @vitest-environment happy-dom */
import type { ConfigAccount, ConfigSnapshot } from '@agnes/protocol'
import { mountRegion, SettingsModelPane } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  type SideModelsClient,
  type SideModelsCredentials,
  SideModelsPanel,
  sideModelsPanel,
} from '../src/settings/side-models.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
  delete (navigator as { clipboard?: unknown }).clipboard
  history.replaceState(null, '', '/')
})

const JEV_MODEL = {
  id: 'typesafe/jev-1.13-20260917',
  name: 'Jev 1.13',
  contextWindow: 65536,
  maxTokens: 32768,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
}

const sideAccount: ConfigAccount = {
  accountId: 'jev',
  label: 'Jev',
  providerId: 'typesafe-systemone',
  route: 'account-jev',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: JEV_MODEL.id,
  models: [JEV_MODEL],
  enabled: true,
  credentialConfigured: true,
  authType: 'api-key',
}

const chatAccount: ConfigAccount = {
  accountId: 'work',
  label: 'Work',
  providerId: 'openai',
  route: 'account-work',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt',
  models: [{ id: 'gpt', name: 'GPT' }],
  enabled: true,
  credentialConfigured: true,
  authType: 'api-key',
}

function snapshot(accounts: ConfigAccount[], revision = 1): ConfigSnapshot {
  return {
    profile: 'local-dev',
    revision,
    configured: true,
    provider: null,
    accounts,
    defaultAccountId: accounts.some((row) => row.providerId === 'openai') ? 'work' : null,
    effect: 'new-sessions',
  }
}

type FakeClient = SideModelsClient & {
  get: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  test: ReturnType<typeof vi.fn>
  account: ReturnType<typeof vi.fn>
}

function client(accounts: ConfigAccount[] = [chatAccount, sideAccount]): FakeClient {
  let revision = 1
  return {
    get: vi.fn(async () => snapshot(accounts, revision)),
    save: vi.fn(async () => snapshot(accounts, ++revision)),
    test: vi.fn(async () => ({ models: [], verified: true })),
    account: vi.fn(async () => snapshot(accounts, ++revision)),
  }
}

const credentials = (
  items = [{ id: 'secret://generic/11111111-1111-4111-8111-111111111111', label: 'OR key' }],
) =>
  ({
    list: vi.fn(async () => items),
    create: vi.fn(async (label: string) => ({
      id: 'secret://generic/22222222-2222-4222-8222-222222222222',
      label,
    })),
  }) satisfies SideModelsCredentials

async function mount(
  api: FakeClient,
  options: {
    accounts?: ConfigAccount[]
    canSave?: boolean
    onSaved?: ReturnType<typeof vi.fn<(snapshot: ConfigSnapshot) => Promise<void>>>
    credentials?: SideModelsCredentials
  } = {},
) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const onSaved = options.onSaved ?? vi.fn<(snapshot: ConfigSnapshot) => Promise<void>>(async () => undefined)
  await act(async () =>
    root.render(
      createElement(SideModelsPanel, {
        client: api,
        configuration: snapshot(options.accounts ?? [chatAccount, sideAccount]),
        canSave: options.canSave ?? true,
        onSaved,
        credentials: options.credentials ?? credentials(),
      }),
    ),
  )
  return { host, onSaved }
}

const input = (host: HTMLElement, testid: string) =>
  host.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)
async function type(host: HTMLElement, testid: string, value: string) {
  await act(async () => {
    const field = input(host, testid)
    if (!field) throw new Error(`missing ${testid}`)
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function choose(host: HTMLElement, testid: string, value: string) {
  await act(async () => {
    const field = host.querySelector<HTMLSelectElement>(`[data-testid="${testid}"]`)
    if (!field) throw new Error(`missing ${testid}`)
    field.value = value
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function click(host: HTMLElement, testid: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)?.click())
}
/** The row menu renders into the document body, outside the panel. */
async function openMenu(host: HTMLElement, accountId: string) {
  await click(host, `side-model-menu-${accountId}`)
}
async function menuItem(host: HTMLElement, accountId: string, testid: string) {
  await openMenu(host, accountId)
  const item = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
  if (!item) throw new Error(`missing ${testid}`)
  await act(async () => item.click())
}

it('lists only payload-only accounts as account-style cards with a counted heading', async () => {
  const { host } = await mount(client())
  expect(host.querySelector('[data-testid="side-models-title"]')?.textContent).toBe('Side models')
  expect(host.querySelector('[data-testid="side-models-count"]')?.textContent).toBe('· 1')
  expect(host.querySelector('[data-testid="side-models-note"]')?.textContent).toContain(
    'Payload requests only',
  )
  const row = host.querySelector('[data-testid="side-model-jev"]')
  expect(row?.textContent).toContain('Jev')
  expect(row?.textContent).toContain('TypeSafe System One')
  expect(row?.querySelector('[data-testid="side-model-route-jev"]')?.textContent).toBe('account-jev')
  // One model shows its version; the endpoint shows as its host.
  expect(row?.textContent).toContain('Jev 1.13')
  expect(row?.textContent).toContain('openrouter.ai')
  expect(row?.textContent).not.toContain('https://')
  // A configured, enabled entry carries no status tag.
  expect(row?.querySelector('.agnes-settings-tag')).toBeNull()
  // The chat account stays with the account list above; this group never renders it.
  expect(host.querySelector('[data-testid="side-model-work"]')).toBeNull()
  // The adapter is the payload-only registration, never a chat provider.
  await click(host, 'side-model-add')
  const adapter = host.querySelector('[data-testid="side-adapter"]')
  expect(adapter?.getAttribute('data-value')).toBe('typesafe-systemone')
  expect(adapter?.textContent).toContain('TypeSafe System One')
})

it('tags a missing credential and a disabled entry, and summarizes several models by count', async () => {
  const evaluation: ConfigAccount = {
    ...sideAccount,
    accountId: 'jev-eval',
    label: 'Jev eval',
    route: 'account-jev-eval',
    baseUrl: 'http://localhost:8080/v1',
    models: [JEV_MODEL, { ...JEV_MODEL, id: 'typesafe/jev-1.14', name: 'Jev 1.14' }],
    enabled: false,
    credentialConfigured: false,
  }
  const accounts = [chatAccount, sideAccount, evaluation]
  const { host } = await mount(client(accounts), { accounts })
  expect(host.querySelector('[data-testid="side-models-count"]')?.textContent).toBe('· 2')
  const row = host.querySelector('[data-testid="side-model-jev-eval"]')
  expect(row?.getAttribute('data-enabled')).toBe('false')
  expect([...(row?.querySelectorAll('.agnes-settings-tag') ?? [])].map((tag) => tag.textContent)).toEqual([
    'Credential missing',
    'Disabled',
  ])
  expect(row?.textContent).toContain('2 models')
  expect(row?.textContent).toContain('localhost:8080')
  expect(host.querySelector('[data-testid="side-model-toggle-jev-eval"]')?.getAttribute('aria-label')).toBe(
    'Enable Jev eval',
  )
  expect(host.querySelector('[data-testid="side-model-toggle-jev"]')?.getAttribute('aria-label')).toBe(
    'Disable Jev',
  )
})

it('shows an empty state with its own add action and no route hint', async () => {
  const { host } = await mount(client([chatAccount]), { accounts: [chatAccount] })
  const empty = host.querySelector('[data-testid="side-models-empty"]')
  expect(empty?.textContent).toContain('No side models yet')
  expect(empty?.textContent).toContain('Loop plugins (such as the Jev loop) call it')
  // The add icon sits in the button's icon slot, beside the label rather than above it.
  expect(empty?.querySelector('[data-testid="side-model-add"] .ant-btn-icon svg')).not.toBeNull()
  // The empty state's description replaces the group note instead of repeating it.
  expect(host.querySelector('[data-testid="side-models-note"]')).toBeNull()
  expect(host.querySelector('[data-testid="side-models-count"]')).toBeNull()
  expect(host.querySelector('[data-testid="side-model-route-hint"]')).toBeNull()
  await click(host, 'side-model-add')
  expect(host.querySelector('[data-testid="side-editor"]')).not.toBeNull()
  expect(host.querySelector('[data-testid="side-models-empty"]')).toBeNull()
})

it('prefills the Jev template for a new entry and keeps every prefilled field a draft', async () => {
  const api = client([chatAccount])
  const { host } = await mount(api, { accounts: [chatAccount] })
  await click(host, 'side-model-add')
  expect(input(host, 'side-base-url')?.value).toBe('https://openrouter.ai/api/v1')
  expect(input(host, 'side-model-id-0')?.value).toBe('typesafe/jev-1.13-20260917')
  expect(input(host, 'side-model-name-0')?.value).toBe('Jev 1.13 (2026-09-17)')
  expect(input(host, 'side-model-context-0')?.value).toBe('65536')
  expect(input(host, 'side-model-tokens-0')?.value).toBe('32768')
  // The label is prefilled too; the credential remains the user's to pick.
  expect(input(host, 'side-label')?.value).toBe('Jev')
  // Prefill is a draft: an edited id is what gets saved.
  await type(host, 'side-model-id-0', 'typesafe/jev-1.14-20261020')
  await choose(host, 'side-credential', 'secret://generic/11111111-1111-4111-8111-111111111111')
  await click(host, 'side-save')
  const sent = api.save.mock.calls[0]?.[0] as Record<string, unknown>
  expect(sent).toMatchObject({
    model: 'typesafe/jev-1.14-20261020',
    models: [
      {
        id: 'typesafe/jev-1.14-20261020',
        name: 'Jev 1.13 (2026-09-17)',
        contextWindow: 65536,
        maxTokens: 32768,
      },
    ],
  })
})

it('shows the saved route name with a copy button and the loop-plugin hint', async () => {
  const written: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        written.push(text)
      },
    },
  })
  const { host } = await mount(client())
  const row = host.querySelector('[data-testid="side-model-jev"]')
  expect(row?.textContent).toContain('account-jev')
  expect(host.querySelector('[data-testid="side-model-route-hint"]')?.textContent).toBe(
    'Put the route name above into the loop plugin setting jev.route.',
  )
  await click(host, 'side-model-copy-jev')
  expect(written).toEqual(['account-jev'])
  expect(host.querySelector('[data-testid="side-model-copied-jev"]')?.textContent).toContain('Copied')
  // The row menu copies the same name.
  await menuItem(host, 'jev', 'side-model-menu-copy-jev')
  expect(written).toEqual(['account-jev', 'account-jev'])
})

it('offers edit, copy, test and remove in the row menu and tests the saved entry from there', async () => {
  const api = client()
  const { host } = await mount(api)
  await openMenu(host, 'jev')
  expect(
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent),
  ).toEqual(['Edit', 'Copy route name', 'Test connection', 'Remove…'])
  await menuItem(host, 'jev', 'side-model-menu-test-jev')
  expect(api.test).toHaveBeenCalledWith({
    providerId: 'typesafe-systemone',
    accountId: 'jev',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: JEV_MODEL.id,
  })
  expect(host.querySelector('[data-testid="side-model-test-status-jev"]')?.textContent).toBe(
    'Endpoint reachable',
  )
  await menuItem(host, 'jev', 'side-model-menu-edit-jev')
  expect(input(host, 'side-label')?.value).toBe('Jev')
})

it('shows the group copy in zh-CN when the document is zh-CN', async () => {
  document.documentElement.lang = 'zh-CN'
  const { host } = await mount(client())
  expect(host.querySelector('[data-testid="side-models-title"]')?.textContent).toBe('旁路模型')
  expect(host.querySelector('[data-testid="side-models-note"]')?.textContent).toBe(
    '只接收载荷请求，不出现在对话的模型选择里。循环插件按路由名调用它。',
  )
  expect(host.querySelector('[data-testid="side-model-route-hint"]')?.textContent).toBe(
    '在循环插件设置的 jev.route 里填入上面的路由名。',
  )
  await menuItem(host, 'jev', 'side-model-remove-jev')
  expect(host.querySelector('[data-testid="side-model-remove-strip-jev"]')?.textContent).toContain(
    '删除「Jev」？引用 account-jev 的循环插件会调用失败。凭据不会被删除。',
  )
  await click(host, 'side-model-remove-cancel-jev')
  await click(host, 'side-model-edit-jev')
  await type(host, 'side-base-url', 'https://replacement.example.invalid/v1')
  expect(host.textContent).toContain('端点已更改。请重新选择凭据，授权将其发送到此端点。')
  await type(host, 'side-base-url', 'http://vendor.example.invalid/v1')
  await click(host, 'side-save')
  expect(host.textContent).toContain('请输入绝对 HTTPS URL')
})

it('adds an account through the editor: adapter fixed, credential picked or created, five model fields', async () => {
  const api = client([chatAccount])
  const onSaved = vi.fn<(snapshot: ConfigSnapshot) => Promise<void>>(async () => undefined)
  const store = credentials()
  const { host } = await mount(api, { accounts: [chatAccount], onSaved, credentials: store })
  expect(host.querySelector('[data-testid="side-model-jev"]')).toBeNull()
  await click(host, 'side-model-add')
  expect(input(host, 'side-base-url')?.value).toBe('https://openrouter.ai/api/v1')
  await type(host, 'side-label', 'Jev')
  await type(host, 'side-model-id-0', JEV_MODEL.id)
  await type(host, 'side-model-name-0', 'Jev 1.13')
  await type(host, 'side-model-context-0', '65536')
  await type(host, 'side-model-tokens-0', '32768')
  // Pricing is a fold: open it before entering the four prices.
  await click(host, 'side-model-cost-toggle-0')
  await type(host, 'side-model-cost-input-0', '0.042')
  await type(host, 'side-model-cost-output-0', '0')
  await type(host, 'side-model-cost-cache-read-0', '0')
  await type(host, 'side-model-cost-cache-write-0', '0')
  await choose(host, 'side-credential', 'secret://generic/11111111-1111-4111-8111-111111111111')
  await click(host, 'side-save')
  expect(api.save).toHaveBeenCalledTimes(1)
  const sent = api.save.mock.calls[0]?.[0] as Record<string, unknown>
  expect(sent).toMatchObject({
    providerId: 'typesafe-systemone',
    label: 'Jev',
    baseUrl: 'https://openrouter.ai/api/v1',
    credentialRef: 'secret://generic/11111111-1111-4111-8111-111111111111',
    model: JEV_MODEL.id,
    models: [JEV_MODEL],
    expectedRevision: 1,
  })
  expect(String(sent.accountId)).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/)
  expect(sent.apiKey).toBeUndefined()
  expect(sent.makeDefault).toBeUndefined()
  expect(onSaved).toHaveBeenCalled()

  // A credential can be created in place; the new reference becomes the selection.
  await click(host, 'side-model-add')
  expect(host.querySelector('[data-testid="side-credential-new-label"]')).toBeNull()
  await click(host, 'side-credential-new')
  await type(host, 'side-credential-new-label', 'Direct key')
  await type(host, 'side-credential-new-value', 'jev-secret')
  await click(host, 'side-credential-create')
  expect(store.create).toHaveBeenCalledWith('Direct key', 'jev-secret')
  const select = host.querySelector<HTMLSelectElement>('[data-testid="side-credential"]')
  expect(select?.value).toBe('secret://generic/22222222-2222-4222-8222-222222222222')
})

it('refuses to save without a credential, with a malformed endpoint, or with a broken model row', async () => {
  const api = client([chatAccount])
  const { host } = await mount(api, { accounts: [chatAccount] })
  await click(host, 'side-model-add')
  await click(host, 'side-save')
  expect(api.save).not.toHaveBeenCalled()
  expect(host.querySelector('[data-testid="side-models-status"]')?.getAttribute('role')).toBe('alert')
  await type(host, 'side-label', 'Jev')
  await type(host, 'side-model-id-0', JEV_MODEL.id)
  await type(host, 'side-model-name-0', 'Jev 1.13')
  await type(host, 'side-model-context-0', '65536')
  await type(host, 'side-model-tokens-0', '32768')
  await choose(host, 'side-credential', 'secret://generic/11111111-1111-4111-8111-111111111111')
  await type(host, 'side-base-url', 'http://192.0.2.1/v1')
  await click(host, 'side-save')
  expect(api.save).not.toHaveBeenCalled()
  await type(host, 'side-base-url', 'https://openrouter.ai/api/v1')
  await type(host, 'side-model-tokens-0', 'not-a-number')
  await click(host, 'side-save')
  expect(api.save).not.toHaveBeenCalled()
})

it('requires a credential selection for an edited endpoint and locates server refusals', async () => {
  const api = client()
  const { host } = await mount(api)
  await click(host, 'side-model-edit-jev')
  expect(input(host, 'side-base-url')?.value).toBe('https://openrouter.ai/api/v1')
  expect(input(host, 'side-model-id-0')?.value).toBe(JEV_MODEL.id)
  await type(host, 'side-base-url', 'https://api.typesafe.ai/v1')
  expect(host.textContent).toContain(
    'Endpoint changed. Choose a credential again to authorize sending it to this endpoint.',
  )
  await click(host, 'side-save')
  expect(api.save).not.toHaveBeenCalled()
  expect(host.querySelector('[data-testid="side-credential"]')?.getAttribute('aria-invalid')).toBe('true')
  await choose(host, 'side-credential', 'secret://generic/11111111-1111-4111-8111-111111111111')
  api.save.mockRejectedValueOnce({ data: { reason: 'CONFIG_CREDENTIAL_REQUIRED', field: 'credentialRef' } })
  await click(host, 'side-save')
  expect(host.querySelector('[data-testid="side-credential"]')?.getAttribute('aria-invalid')).toBe('true')
  expect(host.textContent).toContain('Choose a credential again')
  await choose(host, 'side-credential', 'secret://generic/11111111-1111-4111-8111-111111111111')
  api.save.mockRejectedValueOnce({
    data: { reason: 'CONFIG_INVALID_INPUT', field: 'baseUrl', messageKey: 'appServer.errors.invalidParams' },
  })
  await click(host, 'side-save')
  expect(input(host, 'side-base-url')?.getAttribute('aria-invalid')).toBe('true')
  expect(host.textContent).toContain('Use an absolute HTTPS URL')
  await click(host, 'side-save')
  const sent = api.save.mock.calls[0]?.[0] as Record<string, unknown>
  expect(sent).toMatchObject({
    accountId: 'jev',
    baseUrl: 'https://api.typesafe.ai/v1',
    model: JEV_MODEL.id,
    expectedRevision: 1,
  })
  expect(sent.credentialRef).toBe('secret://generic/11111111-1111-4111-8111-111111111111')
})

it('probes on demand and still saves without probing, saying the test is optional', async () => {
  const api = client()
  const { host } = await mount(api)
  await click(host, 'side-model-edit-jev')
  expect(host.querySelector('[data-testid="side-test-note"]')?.textContent).toContain('optional')
  await click(host, 'side-test')
  expect(api.test).toHaveBeenCalledWith(
    expect.objectContaining({ providerId: 'typesafe-systemone', accountId: 'jev' }),
  )
  expect(host.querySelector('[data-testid="side-test-status"]')?.textContent).toContain('reachable')
  api.test.mockResolvedValueOnce({ models: [], verified: false })
  await click(host, 'side-test')
  expect(host.querySelector('[data-testid="side-test-status"]')?.textContent).toContain('not reachable')
  // A failed probe never blocks saving.
  await click(host, 'side-save')
  expect(api.save).toHaveBeenCalledTimes(1)
})

it('disables, enables and removes an account through the account action, confirming removal inline', async () => {
  const api = client()
  const { host } = await mount(api)
  await click(host, 'side-model-toggle-jev')
  expect(api.account).toHaveBeenCalledWith({ accountId: 'jev', action: 'disable', expectedRevision: 1 })
  // 删除… only arms the confirmation strip, which names the route and keeps the credential.
  await menuItem(host, 'jev', 'side-model-remove-jev')
  expect(api.account).toHaveBeenCalledTimes(1)
  const strip = host.querySelector('[data-testid="side-model-remove-strip-jev"]')
  expect(strip?.getAttribute('role')).toBe('alert')
  expect(strip?.textContent).toContain(
    'Remove “Jev”? Loop plugins that reference account-jev will fail to call it. The credential is not deleted.',
  )
  await click(host, 'side-model-remove-cancel-jev')
  expect(host.querySelector('[data-testid="side-model-remove-strip-jev"]')).toBeNull()
  expect(api.account).toHaveBeenCalledTimes(1)
  await menuItem(host, 'jev', 'side-model-remove-jev')
  await click(host, 'side-model-remove-confirm-jev')
  expect(api.account).toHaveBeenCalledWith({ accountId: 'jev', action: 'remove', expectedRevision: 1 })
})

it('rereads the configuration after a revision conflict and says so', async () => {
  const api = client()
  api.save.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'CONFIG_REVISION_CONFLICT' }))
  const onSaved = vi.fn<(snapshot: ConfigSnapshot) => Promise<void>>(async () => undefined)
  const { host } = await mount(api, { onSaved })
  await click(host, 'side-model-edit-jev')
  await type(host, 'side-label', 'Jev renamed')
  await click(host, 'side-save')
  expect(api.get).toHaveBeenCalled()
  expect(onSaved).toHaveBeenCalled()
  expect(host.querySelector('[data-testid="side-models-status"]')?.textContent).toContain('changed')
})

it('keeps everything read-only when saving is not allowed', async () => {
  const { host } = await mount(client(), { canSave: false })
  expect(host.querySelector<HTMLButtonElement>('[data-testid="side-model-add"]')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[data-testid="side-model-edit-jev"]')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[data-testid="side-model-toggle-jev"]')?.disabled).toBe(true)
  // The route name stays copyable; editing and removing do not.
  await openMenu(host, 'jev')
  const disabled = (testid: string) =>
    document.querySelector(`[data-testid="${testid}"]`)?.getAttribute('aria-disabled')
  expect(disabled('side-model-menu-edit-jev')).toBe('true')
  expect(disabled('side-model-remove-jev')).toBe('true')
  expect(disabled('side-model-menu-copy-jev')).not.toBe('true')
})

it('derives the route from the label live and disambiguates collisions with existing accounts', async () => {
  const api = client()
  const { host } = await mount(api)
  await click(host, 'side-model-add')
  expect(input(host, 'side-label')?.value).toBe('Jev')
  // The label is prefilled, and account-jev is taken: the preview disambiguates with a suffix.
  expect(host.querySelector('[data-testid="side-route-preview"]')?.textContent).toContain('account-jev-2')
  await type(host, 'side-label', 'My Side Model')
  expect(host.querySelector('[data-testid="side-route-preview"]')?.textContent).toContain(
    'account-my-side-model',
  )
  // A label with no ASCII letters or digits falls back to a generated id.
  await type(host, 'side-label', '纯中文')
  expect(host.querySelector('[data-testid="side-route-preview"]')?.textContent).toMatch(
    /account-jev-[0-9a-f]{8}/,
  )
  // The derived id is what gets saved.
  await type(host, 'side-label', 'My Side Model')
  await choose(host, 'side-credential', 'secret://generic/11111111-1111-4111-8111-111111111111')
  await click(host, 'side-save')
  expect(api.save.mock.calls[0]?.[0]).toMatchObject({ accountId: 'my-side-model' })
})

it('keeps pricing collapsed by default and only saves it when expanded with values', async () => {
  const api = client([chatAccount])
  const { host } = await mount(api, { accounts: [chatAccount] })
  await click(host, 'side-model-add')
  expect(host.querySelector('[data-testid="side-model-cost-input-0"]')).toBeNull()
  await choose(host, 'side-credential', 'secret://generic/11111111-1111-4111-8111-111111111111')
  await click(host, 'side-save')
  const first = api.save.mock.calls[0]?.[0] as Record<string, unknown>
  expect((first.models as { cost?: unknown }[])[0]?.cost).toBeUndefined()

  await click(host, 'side-model-add')
  await click(host, 'side-model-cost-toggle-0')
  await type(host, 'side-model-cost-input-0', '0.042')
  await type(host, 'side-model-cost-output-0', '0')
  await type(host, 'side-model-cost-cache-read-0', '0')
  await type(host, 'side-model-cost-cache-write-0', '0')
  await choose(host, 'side-credential', 'secret://generic/11111111-1111-4111-8111-111111111111')
  await click(host, 'side-save')
  const second = api.save.mock.calls[1]?.[0] as Record<string, unknown>
  expect((second.models as { cost?: unknown }[])[0]?.cost).toEqual({
    input: 0.042,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  })
})

it('pushes the editor as a settings subpage and leaves it by cancel, back or save', async () => {
  // The real pane: the panel mounts into its side-model host and borrows its two hidden pages.
  const paneHost = document.createElement('div')
  document.body.append(paneHost)
  let release = () => {}
  await act(async () => {
    release = mountRegion(
      paneHost,
      createElement(SettingsModelPane, { beforeAccounts: null, afterAccounts: null }),
    )
  })
  const sideHost = paneHost.querySelector<HTMLElement>('#config-side-models')
  if (!sideHost) throw new Error('missing side-model host')
  const api = client()
  const root = createRoot(sideHost)
  roots.push(root)
  const store = credentials()
  // As the settings controller does: a save renders the panel again, keyed by the new revision.
  const render = (configuration: ConfigSnapshot): void =>
    root.render(
      sideModelsPanel({
        client: api,
        configuration,
        canSave: true,
        onSaved: async (saved) => render(saved),
        credentials: store,
      }),
    )
  await act(async () => render(snapshot([chatAccount, sideAccount])))
  const page = (id: string) => document.querySelector<HTMLElement>(`[data-testid="settings-subpage-${id}"]`)
  const body = document.body

  await click(body, 'side-model-add')
  expect(page('add-side-model')?.querySelector('[data-testid="side-editor"]')).not.toBeNull()
  expect(input(page('add-side-model') ?? body, 'side-label')?.value).toBe('Jev')
  // The list is not where the editor is.
  expect(sideHost.querySelector('[data-testid="side-editor"]')).toBeNull()
  await click(body, 'side-cancel')
  expect(page('add-side-model')).toBeNull()
  expect(body.querySelector('[data-testid="side-editor"]')).toBeNull()

  await click(body, 'side-model-edit-jev')
  expect(input(page('side-model') ?? body, 'side-label')?.value).toBe('Jev')
  await type(body, 'side-label', 'Jev renamed')
  // The page's back control drops the draft.
  await click(body, 'settings-subpage-back')
  expect(page('side-model')).toBeNull()
  expect(body.querySelector('[data-testid="side-editor"]')).toBeNull()
  await click(body, 'side-model-edit-jev')
  expect(input(body, 'side-label')?.value).toBe('Jev')

  // Saving closes the page even though the saved revision remounts the panel under it.
  await click(body, 'side-save')
  expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'jev', label: 'Jev' }))
  expect(page('side-model')).toBeNull()
  expect(body.querySelector('[data-testid="side-editor"]')).toBeNull()
  await click(body, 'side-model-add')
  await choose(body, 'side-credential', 'secret://generic/11111111-1111-4111-8111-111111111111')
  await click(body, 'side-save')
  expect(api.save).toHaveBeenCalledTimes(2)
  expect(page('add-side-model')).toBeNull()
  expect(body.querySelector('[data-testid="side-editor"]')).toBeNull()
  await act(async () => release())
})

it('opens the pricing fold for a saved model that has one', async () => {
  const { host } = await mount(client())
  await click(host, 'side-model-edit-jev')
  expect(input(host, 'side-model-cost-input-0')?.value).toBe('0.042')
})
