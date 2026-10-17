/** @vitest-environment happy-dom */
import type { ConfigAccount, ConfigSnapshot } from '@agnes/protocol'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  type SideModelsClient,
  type SideModelsCredentials,
  SideModelsPanel,
} from '../src/settings/side-models.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
  delete (navigator as { clipboard?: unknown }).clipboard
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

it('lists only payload-only accounts with the badge, summary and fixed group copy', async () => {
  const { host } = await mount(client())
  expect(host.querySelector('[data-testid="side-models-title"]')?.textContent).toBe('Side models')
  expect(host.querySelector('[data-testid="side-models-note"]')?.textContent).toContain(
    'Payload requests only',
  )
  const row = host.querySelector('[data-testid="side-model-jev"]')
  expect(row?.textContent).toContain('Jev')
  expect(row?.textContent).toContain('TypeSafe System One')
  expect(row?.textContent).toContain('account-jev')
  expect(row?.textContent).toContain('https://openrouter.ai/api/v1')
  expect(row?.textContent).toContain('1')
  expect(row?.querySelector('[data-testid="side-model-badge"]')?.textContent).toBe(
    'Payload requests only, no chat',
  )
  // The chat account stays with the account list above; this group never renders it.
  expect(host.querySelector('[data-testid="side-model-work"]')).toBeNull()
  // The adapter choice is the payload-only registration, never a chat provider.
  await click(host, 'side-model-add')
  const adapter = host.querySelector<HTMLSelectElement>('[data-testid="side-adapter"]')
  expect([...(adapter?.options ?? [])].map((item) => item.value)).toEqual(['typesafe-systemone'])
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
    models: [{ id: 'typesafe/jev-1.14-20261020', name: 'Jev 1.13 (2026-09-17)', contextWindow: 65536, maxTokens: 32768 }],
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
  expect(row?.textContent).toContain('jev.route')
  await click(host, 'side-model-copy-jev')
  expect(written).toEqual(['account-jev'])
  expect(host.querySelector('[data-testid="side-model-copied-jev"]')?.textContent).toContain('Copied')
})

it('shows the group copy in zh-CN when the document is zh-CN', async () => {
  document.documentElement.lang = 'zh-CN'
  const { host } = await mount(client())
  expect(host.querySelector('[data-testid="side-models-title"]')?.textContent).toBe('旁路模型')
  expect(host.querySelector('[data-testid="side-models-note"]')?.textContent).toContain('仅载荷请求')
  expect(host.querySelector('[data-testid="side-model-badge"]')?.textContent).toBe('仅载荷请求，不用于对话')
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

it('edits an existing account, keeping its credential unless another is picked', async () => {
  const api = client()
  const { host } = await mount(api)
  await click(host, 'side-model-edit-jev')
  expect(input(host, 'side-base-url')?.value).toBe('https://openrouter.ai/api/v1')
  expect(input(host, 'side-model-id-0')?.value).toBe(JEV_MODEL.id)
  await type(host, 'side-base-url', 'https://api.typesafe.ai/v1')
  // The endpoint changed, so the probe needs the credential named again; saving keeps the stored one.
  await click(host, 'side-save')
  const sent = api.save.mock.calls[0]?.[0] as Record<string, unknown>
  expect(sent).toMatchObject({
    accountId: 'jev',
    baseUrl: 'https://api.typesafe.ai/v1',
    model: JEV_MODEL.id,
    expectedRevision: 1,
  })
  expect(sent.credentialRef).toBeUndefined()
})

it('probes on demand and still saves without probing, saying the probe semantics are provisional', async () => {
  const api = client()
  const { host } = await mount(api)
  await click(host, 'side-model-edit-jev')
  expect(host.querySelector('[data-testid="side-test-note"]')?.textContent).toContain('skip')
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

it('disables, enables and removes an account through the account action, arming removal first', async () => {
  const api = client()
  const { host } = await mount(api)
  await click(host, 'side-model-toggle-jev')
  expect(api.account).toHaveBeenCalledWith({ accountId: 'jev', action: 'disable', expectedRevision: 1 })
  await click(host, 'side-model-remove-jev')
  expect(api.account).toHaveBeenCalledTimes(1)
  await click(host, 'side-model-remove-jev')
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
  expect(host.querySelector<HTMLButtonElement>('[data-testid="side-model-remove-jev"]')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[data-testid="side-model-toggle-jev"]')?.disabled).toBe(true)
})

it('derives the route from the label live and disambiguates collisions with existing accounts', async () => {
  const api = client()
  const { host } = await mount(api)
  await click(host, 'side-model-add')
  expect(input(host, 'side-label')?.value).toBe('Jev')
  // The label is prefilled, and account-jev is taken: the preview disambiguates with a suffix.
  expect(host.querySelector('[data-testid="side-route-preview"]')?.textContent).toContain(
    'account-jev-2',
  )
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
  expect((api.save.mock.calls[0]?.[0] as Record<string, unknown>).accountId).toBe('my-side-model')
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

it('opens the pricing fold for a saved model that has one', async () => {
  const { host } = await mount(client())
  await click(host, 'side-model-edit-jev')
  expect(input(host, 'side-model-cost-input-0')?.value).toBe('0.042')
})
