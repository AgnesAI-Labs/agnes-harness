import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import {
  CODEX_ID,
  CODEX_PROVIDER,
  type CodexCredential,
  codexAuth,
  getSubscriptionProvider,
  type SubscriptionCredential,
  type SubscriptionProviderId,
} from '@agnes/ai'
import { fakeRequest } from '@agnes/ai/testkit'
import * as systemNode from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { codexCredentials, subscriptionCredentials } from '../src/adapters/codex-credentials.js'
import * as credentialStores from '../src/adapters/credential-store.js'
import { createCredentialStore } from '../src/adapters/credential-store.js'
import { buildProvider } from '../src/assemble/provider.js'
import { createCodexLogin } from '../src/codex-login.js'
import { createConfigurationService } from '../src/configuration.js'
import type { ResolvedProfile } from '../src/profile/types.js'

function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('missing fixture value')
  return value
}
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})
async function root() {
  const r = await mkdtemp(join(tmpdir(), 'agnes-oauth-'))
  roots.push(r)
  return join(r, 'home')
}
const token = (accountId = 'account-a') =>
  `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.signature`
const credential = (expires = Date.now() + 3600_000): CodexCredential => ({
  type: 'oauth',
  access: token(),
  refresh: 'private-refresh',
  expires,
  accountId: 'account-a',
})
const ref = 'secret://openai-codex/account-test-r1'

it.each([false, true])('converts saved Kimi OAuth to API key (write failure: %s)', async (failWrite) => {
  const home = await root()
  const store = createCredentialStore({ root: home })
  vi.spyOn(credentialStores, 'createCredentialStore').mockReturnValue(store)
  const model = must(getSubscriptionProvider('kimi-coding')?.models()[0]).id
  const service = createConfigurationService({
    home,
    profile: 'local-dev',
    request: async () =>
      new Response(JSON.stringify({ data: [{ id: model }] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    subscriptionTest: async () => true,
    subscriptionLogin: async (id, credentials) => {
      await credentials.modify(id, async () => ({
        type: 'oauth',
        access: 'access',
        refresh: 'refresh',
        expires: Date.now() + 3600000,
      }))
    },
  })
  const owner = {},
    lifetime = new AbortController(),
    oauth = must(service.oauth)
  let state = await oauth(
    {
      action: 'start',
      providerId: 'kimi-coding',
      accountId: 'work',
      label: 'Work',
      expectedRevision: 0,
      loginMethod: 'device_code',
    },
    owner,
    lifetime.signal,
  )
  await vi.waitFor(async () => {
    state = await oauth({ action: 'poll', operationId: state.operationId }, owner, lifetime.signal)
    expect(state.state).toBe('ready')
  })
  await oauth({ action: 'commit', operationId: state.operationId, model }, owner, lifetime.signal)
  const before = await service.get()
  if (failWrite) vi.spyOn(store, 'putApiKey').mockRejectedValueOnce(new Error('disk failure'))
  const saved = service.save({
    providerId: 'kimi-coding',
    accountId: 'work',
    apiKey: 'replacement-key',
    model,
    expectedRevision: 1,
  })
  if (failWrite) {
    await expect(saved).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_STORE' })
    expect(await service.get()).toEqual(before)
  } else {
    expect(await saved).toMatchObject({
      revision: 2,
      accounts: [expect.objectContaining({ authType: 'api-key' })],
    })
    const ref = must((await service.profileInput()).provider?.routes?.[0]).credentialRef
    expect(await store.read(must(ref))).toMatchObject({ kind: 'api-key', value: 'replacement-key' })
  }
  lifetime.abort()
})

it('tests the chosen saved OAuth model and preserves classified failures', async () => {
  const home = await root()
  const probe = vi.fn(async () => true)
  const service = createConfigurationService({
    home,
    profile: 'local-dev',
    codexTest: probe,
    codexLogin: async (store) => {
      await store.modify(CODEX_ID, async () => credential())
    },
  })
  const oauth = must(service.oauth),
    owner = {},
    lifetime = new AbortController()
  let state = await oauth(
    { action: 'start', accountId: 'work', label: 'Work', expectedRevision: 0, loginMethod: 'device_code' },
    owner,
    lifetime.signal,
  )
  await vi.waitFor(async () => {
    state = await oauth({ action: 'poll', operationId: state.operationId }, owner, lifetime.signal)
    expect(state.state).toBe('ready')
  })
  const first = must(state.models?.[0]).id,
    alternate = must(state.models?.[1]).id
  await oauth({ action: 'commit', operationId: state.operationId, model: first }, owner, lifetime.signal)
  probe.mockRejectedValueOnce(Object.assign(new Error('private upstream details'), { code: 'NO_MODEL' }))
  await expect(service.test({ providerId: CODEX_ID, accountId: 'work' })).rejects.toMatchObject({
    code: 'CONFIG_SUBSCRIPTION_MODEL',
  })
  await expect(
    service.test({ providerId: CODEX_ID, accountId: 'work', model: alternate }),
  ).resolves.toMatchObject({ verified: true })
  expect(probe).toHaveBeenLastCalledWith(expect.any(String), alternate, expect.any(AbortSignal))
  expect((await service.get()).revision).toBe(1)
  lifetime.abort()
})

it('refreshes an expired staged grant before testing and commits the rotated grant', async () => {
  const now = Date.now()
  const probe = vi.fn(async () => {})
  const commit = vi.fn(async () => ({
    profile: 'local-dev',
    revision: 1,
    configured: true,
    provider: null,
    effect: 'new-sessions' as const,
  }))
  const login = createCodexLogin({
    test: probe,
    commit,
    login: async (id, store) => {
      await store.modify(id, async () => credential(now + 3600000))
    },
  })
  const owner = {},
    lifetime = new AbortController()
  let state = await login(
    { action: 'start', accountId: 'work', label: 'Work', expectedRevision: 0, loginMethod: 'device_code' },
    owner,
    lifetime.signal,
  )
  await vi.waitFor(async () => {
    state = await login({ action: 'poll', operationId: state.operationId }, owner, lifetime.signal)
    expect(state.state).toBe('ready')
  })
  vi.spyOn(Date, 'now').mockReturnValue(now + 7200000)
  const fetch = vi.fn(async () =>
    Response.json({ access_token: token(), refresh_token: 'rotated-staged', expires_in: 3600 }),
  )
  vi.stubGlobal('fetch', fetch)
  const model = must(state.models?.[0]).id
  await login({ action: 'test', operationId: state.operationId, model }, owner, lifetime.signal)
  expect(probe).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ refresh: 'rotated-staged' }),
    model,
    expect.any(AbortSignal),
  )
  await login({ action: 'commit', operationId: state.operationId, model }, owner, lifetime.signal)
  expect(commit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ refresh: 'rotated-staged' }),
    model,
    expect.any(AbortSignal),
  )
  expect(fetch).toHaveBeenCalledTimes(1)
  lifetime.abort()
})

it('bounds staged tests to their owner, blocks concurrent commit and aborts on cancellation', async () => {
  const owner = {},
    lifetime = new AbortController(),
    commit = vi.fn()
  let testSignal: AbortSignal | undefined
  const test = vi.fn(async (_input, _credential, _model, signal: AbortSignal) => {
    testSignal = signal
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
    )
  })
  const login = createCodexLogin({
    commit,
    test,
    login: async (id, store) => {
      await store.modify(id, async () => credential())
    },
  })
  let state = await login(
    { action: 'start', accountId: 'test', label: 'Test', expectedRevision: 0, loginMethod: 'browser' },
    owner,
    lifetime.signal,
  )
  await vi.waitFor(async () => {
    state = await login({ action: 'poll', operationId: state.operationId }, owner, lifetime.signal)
    expect(state.state).toBe('ready')
  })
  const input = { action: 'test' as const, operationId: state.operationId, model: must(state.models?.[0]).id }
  await expect(login(input, {}, lifetime.signal)).rejects.toMatchObject({ code: 'CONFIG_AUTH_EXPIRED' })
  const pending = login(input, owner, lifetime.signal)
  const rejected = expect(pending).rejects.toThrow('cancelled')
  await vi.waitFor(() => expect(test).toHaveBeenCalledTimes(1))
  await expect(login({ ...input, action: 'commit' }, owner, lifetime.signal)).rejects.toMatchObject({
    code: 'CONFIG_INVALID_INPUT',
  })
  await login({ action: 'cancel', operationId: state.operationId }, owner, lifetime.signal)
  await rejected
  expect(testSignal?.aborted).toBe(true)
  expect(commit).not.toHaveBeenCalled()
  lifetime.abort()
})

it('persists the strict credential shapes for all five subscription providers', async () => {
  const home = await root()
  const expires = Date.now() + 3_600_000
  const rows: Array<[SubscriptionProviderId, SubscriptionCredential]> = [
    ['openai-codex', credential(expires)],
    ['anthropic', { type: 'oauth', access: 'claude', refresh: 'r', expires }],
    [
      'github-copilot',
      {
        type: 'oauth',
        access: 'copilot',
        refresh: 'r',
        expires,
        enterpriseUrl: 'github.example.test',
        availableModelIds: ['gpt-4.1'],
      },
    ],
    ['kimi-coding', { type: 'oauth', access: 'kimi', refresh: 'r', expires }],
    ['xai', { type: 'oauth', access: 'grok', refresh: 'r', expires }],
  ]
  for (const [provider, value] of rows) {
    const grant = `secret://${provider}/account-${provider}-r1`
    const store = subscriptionCredentials(home, grant, provider)
    await store.modify(provider, async () => value)
    expect(await store.read(provider)).toEqual(value)
    expect(await createCredentialStore({ root: home }).read(grant)).toMatchObject({
      version: 2,
      kind: 'oauth',
      provider,
    })
  }
  await expect(
    subscriptionCredentials(home, 'secret://anthropic/account-invalid-r1', 'anthropic').modify(
      'anthropic',
      async () => ({
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires,
        enterpriseUrl: 'not-allowed.example',
      }),
    ),
  ).rejects.toMatchObject({ reason: 'schema' })
  expect(() => subscriptionCredentials(home, 'secret://xai/account-mismatch-r1', 'anthropic')).toThrow()
})

it.each([
  ['openai-codex', 'browser'],
  ['anthropic', 'browser'],
  ['github-copilot', 'device_code'],
  ['kimi-coding', 'device_code'],
  ['xai', 'device_code'],
] as const)('stages %s subscription login through its declared %s flow', async (providerId, loginMethod) => {
  const owner = {}
  const lifetime = new AbortController()
  const expires = Date.now() + 3_600_000
  const provider = must(getSubscriptionProvider(providerId))
  const availableModelIds = provider
    .models()
    .slice(0, 2)
    .map(({ id }) => id)
  const value: SubscriptionCredential =
    providerId === 'openai-codex'
      ? credential(expires)
      : {
          type: 'oauth',
          access: `${providerId}-access`,
          refresh: 'refresh',
          expires,
          ...(providerId === 'github-copilot' ? { availableModelIds } : {}),
        }
  const api = createCodexLogin({
    commit: async () => {
      throw new Error('unused')
    },
    login: async (id, store, interaction) => {
      expect(id).toBe(providerId)
      expect(await interaction.prompt({ type: 'select', message: 'method', options: [] })).toBe(loginMethod)
      await store.modify(id, async () => value)
    },
  })
  const started = await api(
    {
      action: 'start',
      providerId,
      accountId: `a-${providerId}`,
      label: provider.displayName,
      expectedRevision: 0,
      loginMethod,
    },
    owner,
    lifetime.signal,
  )
  await vi.waitFor(async () => {
    const result = await api({ action: 'poll', operationId: started.operationId }, owner, lifetime.signal)
    expect(result.state).toBe('ready')
    expect(result.models?.length).toBeGreaterThan(0)
    expect(JSON.stringify(result)).not.toContain(`${providerId}-access`)
  })
  lifetime.abort()
})

it('publishes one Copilot account as stable per-API runtime routes with the selected API first', async () => {
  const home = await root()
  const provider = must(getSubscriptionProvider('github-copilot'))
  const availableModelIds = provider.models().map(({ id }) => id)
  const selected = must(provider.models().find(({ api }) => api === 'anthropic-messages'))
  const service = createConfigurationService({
    home,
    profile: 'local-dev',
    subscriptionTest: async () => true,
    subscriptionLogin: async (id, store) => {
      expect(id).toBe('github-copilot')
      await store.modify(id, async () => ({
        type: 'oauth',
        access: 'copilot-access',
        refresh: 'refresh',
        expires: Date.now() + 3_600_000,
        availableModelIds,
      }))
    },
  })
  const owner = {}
  const lifetime = new AbortController()
  const started = await must(service.oauth)(
    {
      action: 'start',
      providerId: 'github-copilot',
      accountId: 'copilot-work',
      label: 'Copilot Work',
      expectedRevision: 0,
      loginMethod: 'device_code',
    },
    owner,
    lifetime.signal,
  )
  await vi.waitFor(async () =>
    expect(
      (
        await must(service.oauth)(
          { action: 'poll', operationId: started.operationId },
          owner,
          lifetime.signal,
        )
      ).state,
    ).toBe('ready'),
  )
  await must(service.oauth)(
    { action: 'commit', operationId: started.operationId, model: selected.id },
    owner,
    lifetime.signal,
  )
  const routes = must((await service.profileInput()).provider?.routes)
  expect(routes[0]).toMatchObject({
    route: 'account-copilot-work',
    api: 'anthropic-messages',
    credentialRef: expect.stringContaining('secret://github-copilot/'),
  })
  expect(new Set(routes.map(({ api }) => api))).toEqual(
    new Set(['anthropic-messages', 'openai-completions', 'openai-responses']),
  )
  expect(new Set(routes.map(({ credentialRef }) => credentialRef)).size).toBe(1)
  lifetime.abort()
})

it('serializes actual processes and releases the transaction lock after a process crash', async () => {
  const home = await root(),
    store = codexCredentials(home, ref)
  await store.modify(CODEX_ID, async () => credential(1))
  const fixture = fileURLToPath(new URL('./fixtures/codex-refresh.ts', import.meta.url))
  const run = promisify(execFile)
  await Promise.all(
    [1, 2].map(() =>
      run(process.execPath, ['--import', 'tsx', fixture, home, ref, 'update'], {
        timeout: 20_000,
        windowsHide: true,
      }),
    ),
  )
  expect(await store.read(CODEX_ID)).toMatchObject({ expires: 3 })
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, home, ref, 'hold'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exit = once(child, 'exit')
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lock holder did not start')), 15_000)
      child.stdout.on('data', (data) => {
        if (String(data).includes('LOCKED')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('holder exited before ready'))
      })
    })
    child.kill()
    await exit
    await store.modify(CODEX_ID, async (current) =>
      current?.type === 'oauth' ? { ...current, expires: 4 } : undefined,
    )
    expect(await store.read(CODEX_ID)).toMatchObject({ expires: 4 })
  } finally {
    if (child.exitCode === null) child.kill()
    await exit
  }
}, 40_000)

it('production Host assembly reads OAuth at request time and preserves compressed Codex SSE requests', async () => {
  const home = await root(),
    store = codexCredentials(home, ref)
  await store.modify(CODEX_ID, async () => credential())
  const catalog = (await CODEX_PROVIDER.createAdapter()).models(CODEX_ID)
  const record = { ...must(catalog[0]), route: 'account-work' }
  const route = {
    route: record.route,
    api: record.api,
    baseUrl: record.baseUrl,
    credentialRef: ref,
    models: [record],
  }
  const profile = {
    provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [route] },
    limits: {},
    adapters: { secrets: { kind: 'file', path: join(home, 'secrets') } },
  } as ResolvedProfile
  const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const built = await buildProvider(
    profile,
    { primary: { route: route.route, model: record.id } },
    {
      secrets: () => {
        throw new Error('not an API key')
      },
      clock: Date.now,
      log,
    },
  )
  const requests: Request[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses')
      expect(request.headers.get('authorization')).toBe(`Bearer ${token()}`)
      expect(request.headers.get('chatgpt-account-id')).toBe('account-a')
      expect(request.headers.get('content-encoding')).toBe('zstd')
      const body = JSON.parse(zstdDecompressSync(Buffer.from(await request.arrayBuffer())).toString())
      expect(body.model).toBe(record.id)
      const message = {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'OK', annotations: [] }],
      }
      const events = [
        { type: 'response.created', response: { id: 'resp_fixture' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
        { type: 'response.output_item.done', output_index: 0, item: message },
        {
          type: 'response.completed',
          response: {
            id: 'resp_fixture',
            status: 'completed',
            output: [message],
            usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
          },
        },
      ]
      // A real Codex response may omit Content-Type; pi still validates the stream structure.
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
    }),
  )
  const events = []
  for await (const event of built.provider.infer(fakeRequest({ route: route.route, model: record.id }), {
    signal: new AbortController().signal,
    toolNames: [],
  }))
    events.push(event)
  expect(events.at(-1)).toMatchObject({ type: 'done' })
  expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', delta: 'OK' }))
  expect(requests).toHaveLength(1)
  await expect(
    buildProvider(
      {
        ...profile,
        provider: { ...profile.provider, routes: [{ ...route, baseUrl: 'https://example.com' }] },
      },
      { primary: { route: route.route, model: record.id } },
      { secrets: () => '', clock: Date.now, log },
    ),
  ).rejects.toThrow('official endpoint')
})

it.each(['anthropic', 'kimi-coding', 'xai'] as const)(
  'keeps %s API-key accounts out of the OAuth runtime',
  async (id) => {
    const home = await root()
    const grant = `secret://${id}/account-key-r1`
    await createCredentialStore({ root: home }).putApiKey(grant, 'fixture-api-key')
    const entry = must(getSubscriptionProvider(id))
    const model = { ...must(entry.models()[0]), route: 'account-key' }
    const route = {
      route: model.route,
      api: model.api,
      baseUrl: model.baseUrl,
      credentialRef: grant,
      models: [model],
    }
    const secrets = vi.fn(() => 'fixture-api-key')
    const built = await buildProvider(
      {
        provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [route] },
        limits: {},
        adapters: { secrets: { kind: 'file', path: join(home, 'secrets') } },
      } as ResolvedProfile,
      { primary: { route: route.route, model: model.id } },
      {
        secrets,
        clock: Date.now,
        log: { warn() {}, info() {}, error() {}, debug() {} },
      },
    )
    expect(built.provider).toBeDefined()
    expect(secrets).toHaveBeenCalledWith(grant)
  },
)

it('refreshes once across two store/runtime instances, persists V2 and never returns tokens in metadata', async () => {
  const home = await root(),
    a = codexCredentials(home, ref),
    b = codexCredentials(home, ref)
  await a.modify(CODEX_ID, async () => credential(1))
  const fetch = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
    return Response.json({ access_token: token(), refresh_token: 'rotated-refresh', expires_in: 3600 })
  })
  vi.stubGlobal('fetch', fetch)
  const values = await Promise.all([
    codexAuth(a).resolve(new AbortController().signal),
    codexAuth(b).resolve(new AbortController().signal),
  ])
  expect(values).toEqual([token(), token()])
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await createCredentialStore({ root: home }).read(ref)).toMatchObject({
    version: 2,
    refresh: 'rotated-refresh',
  })
  expect(await a.list()).toEqual([{ providerId: CODEX_ID, type: 'oauth' }])
})

it('persists a successful rotation despite cancellation, and a failed refresh preserves the old record', async () => {
  const home = await root(),
    store = codexCredentials(home, ref),
    ac = new AbortController()
  await store.modify(CODEX_ID, async () => credential(1))
  await store.modify(
    CODEX_ID,
    async () => {
      ac.abort()
      return { ...credential(1), refresh: 'rotated' }
    },
    { signal: ac.signal },
  )
  expect(await store.read(CODEX_ID)).toMatchObject({ refresh: 'rotated' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('private-upstream-token', { status: 401 })),
  )
  await expect(codexAuth(store).resolve(new AbortController().signal)).rejects.toThrow('CODEX_AUTH_FAILED')
  expect(await store.read(CODEX_ID)).toMatchObject({ refresh: 'rotated' })
  await expect(
    store.modify(CODEX_ID, async () => ({ ...credential(), accountId: 'different' })),
  ).rejects.toMatchObject({ reason: 'schema' })
})

it('cancels a lock waiter without disrupting the holder, and isolates grants', async () => {
  const home = await root(),
    store = codexCredentials(home, ref)
  await store.modify(CODEX_ID, async () => credential())
  let release!: () => void, entered!: () => void
  const inside = new Promise<void>((r) => {
    entered = r
  })
  const held = store.modify(CODEX_ID, async (current) => {
    entered()
    await new Promise<void>((r) => {
      release = r
    })
    return current
  })
  await inside
  const ac = new AbortController()
  const waiter = codexCredentials(home, ref).modify(CODEX_ID, async () => credential(), { signal: ac.signal })
  ac.abort()
  await expect(waiter).rejects.toBeDefined()
  const other = codexCredentials(home, 'secret://openai-codex/account-other-r1')
  await other.modify(CODEX_ID, async () => ({ ...credential(), accountId: 'other' }))
  release()
  await held
  expect(await store.read(CODEX_ID)).toMatchObject({ accountId: 'account-a' })
  expect(await other.read(CODEX_ID)).toMatchObject({ accountId: 'other' })
})

it('stages login, rejects another connection, commits configuration and retains the grant on model edits', async () => {
  const home = await root()
  const service = createConfigurationService({
    home,
    profile: 'local-dev',
    codexTest: async () => true,
    codexLogin: async (store) => {
      await store.modify(CODEX_ID, async () => credential())
    },
  })
  const owner = {},
    ac = new AbortController()
  const start = {
    action: 'start' as const,
    accountId: 'work',
    label: 'Work Codex',
    expectedRevision: 0,
    loginMethod: 'device_code' as const,
  }
  let state = await must(service.oauth)(start, owner, ac.signal)
  await expect(
    must(service.oauth)({ action: 'poll', operationId: state.operationId }, {}, ac.signal),
  ).rejects.toMatchObject({ code: 'CONFIG_AUTH_EXPIRED' })
  await vi.waitFor(async () => {
    state = await must(service.oauth)({ action: 'poll', operationId: state.operationId }, owner, ac.signal)
    expect(state.state).toBe('ready')
  })
  expect(JSON.stringify(state)).not.toContain('private-refresh')
  expect((await service.get()).accounts).toEqual([])
  const model = must(state.models?.[0]).id
  const tested = await must(service.oauth)(
    { action: 'test', operationId: state.operationId, model },
    owner,
    ac.signal,
  )
  expect(tested.state).toBe('ready')
  expect(tested.snapshot).toBeUndefined()
  expect((await service.get()).accounts).toEqual([])
  await expect(
    must(service.oauth)(
      { action: 'test', operationId: state.operationId, model: 'not-in-catalogue' },
      owner,
      ac.signal,
    ),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  const saved = await must(service.oauth)(
    { action: 'commit', operationId: state.operationId, model },
    owner,
    ac.signal,
  )
  expect(saved.snapshot).toMatchObject({ configured: true, revision: 1 })
  const first = must((await service.profileInput()).provider?.routes?.[0]).credentialRef
  await service.save({
    providerId: CODEX_ID,
    accountId: 'work',
    label: 'Renamed',
    model,
    expectedRevision: 1,
  })
  expect(must((await service.profileInput()).provider?.routes?.[0]).credentialRef).toBe(first)
  expect(await createConfigurationService({ home, profile: 'local-dev' }).get()).toMatchObject({
    configured: true,
    revision: 2,
  })
  expect(await readFile(join(home, 'profiles', 'local-dev', 'configuration.json'), 'utf8')).not.toContain(
    'private-refresh',
  )
  await expect(
    service.test({ providerId: CODEX_ID, accountId: 'work', baseUrl: 'https://example.com' }),
  ).rejects.toMatchObject({ code: 'CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED' })
  ac.abort()
})

it('cancellation and disconnect clear staged credentials; stale revisions cannot replace an account', async () => {
  const home = await root(),
    owner = {},
    ac = new AbortController()
  const check = vi.fn(async () => true)
  const service = createConfigurationService({
    home,
    profile: 'local-dev',
    codexTest: check,
    codexLogin: async (store) => {
      await store.modify(CODEX_ID, async () => credential())
    },
  })
  const start = {
    action: 'start' as const,
    accountId: 'work',
    label: 'Work',
    expectedRevision: 99,
    loginMethod: 'browser' as const,
  }
  const result = await must(service.oauth)(start, owner, ac.signal)
  await vi.waitFor(async () =>
    expect(
      (await must(service.oauth)({ action: 'poll', operationId: result.operationId }, owner, ac.signal))
        .state,
    ).toBe('ready'),
  )
  const model = must((await CODEX_PROVIDER.createAdapter()).models(CODEX_ID)[0]).id
  await expect(
    must(service.oauth)({ action: 'commit', operationId: result.operationId, model }, owner, ac.signal),
  ).rejects.toMatchObject({ code: 'CONFIG_REVISION_CONFLICT' })
  expect(check).not.toHaveBeenCalled()
  ac.abort()
  await expect(
    must(service.oauth)(
      { action: 'poll', operationId: result.operationId },
      owner,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'CONFIG_AUTH_EXPIRED' })
  expect((await service.get()).accounts).toEqual([])
})

it('aborts a manual prompt when browser completion wins and returns no upstream errors', async () => {
  const owner = {},
    ac = new AbortController()
  const api = createCodexLogin({
    commit: async () => {
      throw new Error('unused')
    },
    login: async (_provider, _store, interaction) => {
      const prompt = new AbortController()
      const pending = interaction
        .prompt({ type: 'manual_code', message: 'ignored', signal: prompt.signal })
        .catch(() => undefined)
      prompt.abort()
      await pending
      throw new Error('access=private-refresh')
    },
  })
  const state = await api(
    { action: 'start', accountId: 'a', label: 'A', expectedRevision: 0, loginMethod: 'browser' },
    owner,
    ac.signal,
  )
  await vi.waitFor(async () => {
    const result = await api({ action: 'poll', operationId: state.operationId }, owner, ac.signal)
    expect(result).toMatchObject({ state: 'failed', error: 'CONFIG_AUTH_FAILED' })
    expect(result.prompt).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('private-refresh')
  })
  ac.abort()
})

it('rejects unsupported login methods and provider-supplied authorization URLs outside the allowlist', async () => {
  const owner = {}
  const lifetime = new AbortController()
  const api = createCodexLogin({
    commit: async () => {
      throw new Error('unused')
    },
    login: async (_provider, _store, interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://evil.example/steal' })
    },
  })
  await expect(
    api(
      {
        action: 'start',
        providerId: 'xai',
        accountId: 'xai-work',
        label: 'xAI',
        expectedRevision: 0,
        loginMethod: 'browser',
      },
      owner,
      lifetime.signal,
    ),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  const started = await api(
    {
      action: 'start',
      providerId: 'xai',
      accountId: 'xai-work',
      label: 'xAI',
      expectedRevision: 0,
      loginMethod: 'device_code',
    },
    owner,
    lifetime.signal,
  )
  await vi.waitFor(async () =>
    expect(
      await api({ action: 'poll', operationId: started.operationId }, owner, lifetime.signal),
    ).toMatchObject({ state: 'failed', error: 'CONFIG_AUTH_FAILED' }),
  )
  lifetime.abort()
})

it('failed publication preserves the old grant, and retry publishes a new grant without copying refresh tokens', async () => {
  const home = await root(),
    owner = {},
    controller = new AbortController()
  let account = 'old-account'
  const service = createConfigurationService({
    home,
    profile: 'local-dev',
    codexTest: async () => true,
    codexLogin: async (store) => {
      await store.modify(CODEX_ID, async () => ({
        ...credential(),
        accountId: account,
        access: token(account),
        refresh: `refresh-${account}`,
      }))
    },
  })
  const api = must(service.oauth)
  const login = async (revision: number) => {
    const result = await api(
      {
        action: 'start',
        accountId: 'work',
        label: 'Work',
        expectedRevision: revision,
        loginMethod: 'browser',
      },
      owner,
      controller.signal,
    )
    await vi.waitFor(async () =>
      expect(
        (await api({ action: 'poll', operationId: result.operationId }, owner, controller.signal)).state,
      ).toBe('ready'),
    )
    return result.operationId
  }
  try {
    const model = must((await CODEX_PROVIDER.createAdapter()).models(CODEX_ID)[0]).id
    const first = await login(0)
    await api({ action: 'commit', operationId: first, model }, owner, controller.signal)
    const oldRef = must(must((await service.profileInput()).provider?.routes?.[0]).credentialRef)
    const file = join(home, 'profiles', 'local-dev', 'configuration.json')
    const before = await readFile(file, 'utf8')
    account = 'new-account'
    const second = await login(1)
    const replace = systemNode.renameWriteThrough
    const fault = vi
      .spyOn(systemNode, 'renameWriteThrough')
      .mockImplementation(async (source, target, options) => {
        if (target === file) throw new Error('injected publication failure')
        return replace(source, target, options)
      })
    await expect(
      api({ action: 'commit', operationId: second, model }, owner, controller.signal),
    ).rejects.toMatchObject({ code: 'CONFIG_PERSIST_FAILED' })
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await codexCredentials(home, oldRef).read(CODEX_ID)).toMatchObject({
      refresh: 'refresh-old-account',
    })
    fault.mockRestore()
    const saved = await api({ action: 'commit', operationId: second, model }, owner, controller.signal)
    expect(saved.snapshot?.revision).toBe(2)
    const newRef = must(must((await service.profileInput()).provider?.routes?.[0]).credentialRef)
    expect(newRef).not.toBe(oldRef)
    expect(await codexCredentials(home, newRef).read(CODEX_ID)).toMatchObject({
      refresh: 'refresh-new-account',
    })
    expect(await codexCredentials(home, oldRef).read(CODEX_ID)).toMatchObject({
      refresh: 'refresh-old-account',
    })
    await expect(
      api({ action: 'commit', operationId: second, model: 'another-model' }, owner, controller.signal),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  } finally {
    controller.abort()
  }
})

it('expires abandoned login operations and cancels their provider work', async () => {
  vi.useFakeTimers()
  let aborted = false
  const controller = new AbortController(),
    owner = {}
  const api = createCodexLogin({
    commit: async () => {
      throw new Error('unused')
    },
    login: async (_provider, _store, interaction) => {
      await new Promise<void>((_resolve, reject) =>
        interaction.signal?.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new Error('cancelled'))
          },
          { once: true },
        ),
      )
    },
  })
  try {
    const started = await api(
      { action: 'start', accountId: 'a', label: 'A', expectedRevision: 0, loginMethod: 'device_code' },
      owner,
      controller.signal,
    )
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    expect(aborted).toBe(true)
    await expect(
      api({ action: 'poll', operationId: started.operationId }, owner, controller.signal),
    ).rejects.toMatchObject({ code: 'CONFIG_AUTH_EXPIRED' })
  } finally {
    controller.abort()
    vi.useRealTimers()
  }
})
