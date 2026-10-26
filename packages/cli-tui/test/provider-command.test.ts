import type { ConfigProvider, ConfigSnapshot, ConfigTestResult } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createAnsi } from '../src/ansi.js'
import type { TuiApp } from '../src/app.js'
import { apiKeyProviders, providerSlash } from '../src/provider-command.js'
import { displayWidth } from '../src/terminal.js'
import { TuiTheme } from '../src/theme.js'
import { type ProviderPort, ProviderSetup, type ProviderSetupInit } from '../src/views/provider-setup.js'

const ansi = new TuiTheme('mono').ansi(createAnsi('none'))
const flush = () => new Promise((done) => setTimeout(done, 0))
const KEY = 'sk-test-secret-0123'
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`
const ENTER = '\r'
const ESC = '\x1b'

const provider = (id: string, over: Partial<ConfigProvider> = {}): ConfigProvider => ({
  id,
  label: id.toUpperCase(),
  api: 'openai-completions',
  baseUrl: `https://${id}.example/v1`,
  authMethods: ['api-key'],
  ...over,
})
const PROVIDERS = [provider('zhipu'), provider('deepseek'), provider('codex', { authMethods: ['oauth'] })]
const ok = (): ConfigTestResult => ({
  verified: true,
  models: [
    { id: 'm-1', name: 'M One' },
    { id: 'm-2', name: 'M Two' },
  ],
})
const snapshot = (over: Partial<ConfigSnapshot> = {}): ConfigSnapshot =>
  ({
    profile: 'default',
    revision: 8,
    configured: true,
    provider: null,
    effect: 'new-sessions',
    accounts: [{ accountId: 'legacy-zhipu', providerId: 'zhipu', route: 'zhipu' }],
    ...over,
  }) as unknown as ConfigSnapshot

function setupWith(over: Partial<ProviderPort> = {}, locale = 'en') {
  const port = {
    test: vi.fn(async () => ok()),
    save: vi.fn(async () => snapshot()),
    published: vi.fn(async () => true),
    ...over,
  } satisfies ProviderPort
  const notices: string[] = []
  const dialog = new ProviderSetup({
    ansi,
    locale,
    maxRows: () => 20,
    notice: (text) => {
      if (text !== undefined) notices.push(text)
    },
    changed: () => {},
  })
  const init: ProviderSetupInit = {
    providers: apiKeyProviders(PROVIDERS),
    configured: new Set(['zhipu']),
    revision: 7,
    port,
  }
  const text = (width = 100) => dialog.render(width).join('\n')
  return { dialog, port, init, notices, text }
}

/** Opens the dialog, chooses the first provider and submits the key. */
async function toModelStep(t: ReturnType<typeof setupWith>) {
  t.dialog.show(t.init)
  t.dialog.handleInput(ENTER)
  t.dialog.handleInput(paste(KEY))
  t.dialog.handleInput(ENTER)
  await flush()
}

describe('/provider command', () => {
  const app = (remote: boolean, client: unknown) =>
    ({ locale: 'en', o: { remote }, session: { client } }) as unknown as TuiApp

  it('refuses a remote session without calling the daemon', async () => {
    const config = { get: vi.fn(), providers: vi.fn() }
    const r = await providerSlash(app(true, { config }))
    expect(r.text).toMatch(/only be configured on this machine/)
    expect(r.providerSetup).toBeUndefined()
    expect(config.get).not.toHaveBeenCalled()
  })

  it('offers api-key providers only, marks configured ones and carries the revision', async () => {
    const config = {
      get: async () => snapshot(),
      providers: async () => ({
        providers: [
          ...PROVIDERS,
          provider('openai-compatible'),
          { ...provider('legacy', { authType: 'oauth' }), authMethods: undefined },
          { ...provider('plain'), authMethods: undefined },
        ],
      }),
    }
    const r = await providerSlash(app(false, { config }))
    expect(r.providerSetup?.providers.map((p) => p.id)).toEqual(['zhipu', 'deepseek', 'plain'])
    expect([...(r.providerSetup?.configured ?? [])]).toEqual(['zhipu'])
    expect(r.providerSetup?.revision).toBe(8)
  })

  it('reports a failed read as text and opens nothing', async () => {
    const config = {
      get: async () => {
        throw { code: 'CONFIG_PERSIST_FAILED' }
      },
      providers: async () => ({ providers: PROVIDERS }),
    }
    const r = await providerSlash(app(false, { config }))
    expect(r.providerSetup).toBeUndefined()
    expect(r.text).toMatch(/Could not read the provider list/)
  })

  it('port.published matches the saved account route against what the daemon offers', async () => {
    const apis = vi.fn(async () => ({ profile: { models: [{ route: 'zhipu', id: 'm-1' }] } }))
    const config = { get: async () => snapshot(), providers: async () => ({ providers: PROVIDERS }) }
    const { providerSetup } = await providerSlash(app(false, { config, apis }))
    expect(await providerSetup?.port.published(snapshot(), 'zhipu', 'm-1')).toBe(true)
    expect(await providerSetup?.port.published(snapshot(), 'zhipu', 'm-2')).toBe(false)
  })
})

describe('ProviderSetup', () => {
  it('lists providers with the configured mark, never the OAuth-only ones', () => {
    const t = setupWith()
    t.dialog.show(t.init)
    expect(t.text()).toMatch(/ZHIPU.*configured/)
    expect(t.text()).toContain('DEEPSEEK')
    expect(t.text()).not.toContain('CODEX')
  })

  it.each([
    ['network error', () => ({ ...ok(), catalogueError: { reason: 'network' as const } }), /network error/],
    [
      'HTTP status',
      () => ({ ...ok(), catalogueError: { reason: 'http' as const, status: 401 } }),
      /HTTP 401/,
    ],
    ['unverified', () => ({ ...ok(), verified: false }), /could not be verified/],
  ])('returns to the key step after a failed test (%s) with the key gone', async (_name, result, message) => {
    const t = setupWith({ test: vi.fn(async () => result()) })
    await toModelStep(t)
    expect(t.text()).toMatch(message)
    expect(t.text()).toContain('API key:')
    // The old key is not kept: submitting without typing is refused, not re-sent.
    t.dialog.handleInput(ENTER)
    await flush()
    expect(t.port.test).toHaveBeenCalledTimes(1)
  })

  it('goes back to the provider list when the provider has no models', async () => {
    const t = setupWith({ test: vi.fn(async () => ({ verified: true, models: [] })) })
    await toModelStep(t)
    expect(t.text()).toContain('DEEPSEEK')
    expect(t.notices.at(-1)).toMatch(/no usable models/)
  })

  it('shows a public message for an RPC error, never upstream text', async () => {
    const t = setupWith({
      test: vi.fn(async () => {
        throw { code: 'CONFIG_TEST_FAILED', message: `upstream said ${KEY}` }
      }),
    })
    await toModelStep(t)
    expect(t.text()).toContain('CONFIG_TEST_FAILED')
    expect(t.text()).not.toContain(KEY)
  })

  it('saves with providerId, key, model and expectedRevision, and no accountId', async () => {
    const t = setupWith()
    await toModelStep(t)
    expect(t.port.test).toHaveBeenCalledWith({ providerId: 'zhipu', apiKey: KEY })
    t.dialog.handleInput(ENTER)
    await flush()
    expect(t.port.save).toHaveBeenCalledWith({
      providerId: 'zhipu',
      apiKey: KEY,
      model: 'm-1',
      expectedRevision: 7,
    })
    expect(vi.mocked(t.port.save).mock.calls[0]?.[0]).not.toHaveProperty('accountId')
    expect(t.dialog.open).toBe(false)
    expect(t.notices).toEqual(['Saved ZHIPU / m-1. Switch to it with /model.'])
  })

  it.each([
    ['new-sessions', false, /applies to new sessions/],
    ['restart-required', true, /Restart the daemon/],
  ] as const)('reports effect %s', async (effect, published, message) => {
    const t = setupWith({
      save: vi.fn(async () => snapshot({ effect })),
      published: vi.fn(async () => published),
    })
    await toModelStep(t)
    t.dialog.handleInput(ENTER)
    await flush()
    expect(t.notices.at(-1)).toMatch(message)
    // A restart is needed whatever the model list says, so it is not even asked.
    if (effect === 'restart-required') expect(t.port.published).not.toHaveBeenCalled()
  })

  it('closes on a revision conflict and says to run /provider again', async () => {
    const t = setupWith({
      save: vi.fn(async () => {
        throw { code: 'CONFIG_REVISION_CONFLICT' }
      }),
    })
    await toModelStep(t)
    t.dialog.handleInput(ENTER)
    await flush()
    expect(t.dialog.open).toBe(false)
    expect(t.notices.at(-1)).toMatch(/Run \/provider again/)
  })

  it('returns to the model list on any other save failure so it can be retried with the same key', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce({ code: 'CONFIG_PERSIST_FAILED' })
      .mockResolvedValueOnce(snapshot())
    const t = setupWith({ save })
    await toModelStep(t)
    t.dialog.handleInput(ENTER)
    await flush()
    expect(t.text()).toContain('CONFIG_PERSIST_FAILED')
    expect(t.text()).toContain('m-1')
    t.dialog.handleInput(ENTER)
    await flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1]?.[0]).toMatchObject({ apiKey: KEY })
    expect(t.dialog.open).toBe(false)
  })

  it('forgets the key on Esc: nothing is re-sent and nothing shows it', async () => {
    const t = setupWith()
    await toModelStep(t)
    t.dialog.handleInput(ESC) // model list -> provider list
    expect(t.text()).toContain('DEEPSEEK')
    t.dialog.handleInput(ENTER)
    expect(t.text()).toContain('API key:')
    t.dialog.handleInput(ENTER) // empty: refused, no test call with the old key
    await flush()
    expect(t.port.test).toHaveBeenCalledTimes(1)
    for (const shown of [t.text(), ...t.notices]) expect(shown).not.toContain(KEY)
  })

  it('drops an answer that arrives after Esc closed the dialog', async () => {
    let release: (r: ConfigTestResult) => void = () => {}
    const t = setupWith({ test: vi.fn(() => new Promise<ConfigTestResult>((done) => (release = done))) })
    t.dialog.show(t.init)
    t.dialog.handleInput(ENTER)
    t.dialog.handleInput(paste(KEY))
    t.dialog.handleInput(ENTER)
    expect(t.text()).toContain('Testing')
    t.dialog.handleInput(ESC)
    expect(t.dialog.open).toBe(false)
    release(ok())
    await flush()
    expect(t.dialog.open).toBe(false)
  })

  it.each(['en', 'zh-CN'])('keeps every step inside 100, 60 and 40 columns (%s)', async (locale) => {
    const steps: string[][] = []
    const t = setupWith(
      {
        test: vi.fn(async () => ({
          ...ok(),
          models: [{ id: 'a-very-long-model-identifier-name-v2', name: 'x' }],
        })),
      },
      locale,
    )
    const grab = () => steps.push([100, 60, 40].flatMap((w) => t.dialog.render(w).map((l) => `${w}\t${l}`)))
    t.dialog.show(t.init)
    grab()
    t.dialog.handleInput(ENTER)
    grab()
    t.dialog.handleInput(paste(KEY))
    t.dialog.handleInput(ENTER)
    grab() // testing
    await flush()
    grab() // models
    for (const line of steps.flat()) {
      const [width, text] = [Number(line.split('\t')[0]), line.slice(line.indexOf('\t') + 1)]
      expect(displayWidth(text)).toBeLessThanOrEqual(width)
    }
    expect(steps.flat().length).toBeGreaterThan(20)
  })
})
