import * as fsPromises from 'node:fs/promises'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getApiKeyProvider } from '@agnes/ai'
import { mergeRoutes } from '@agnes/host-common/profile/resolve'
import * as systemNode from '@agnes/system-node'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { createCredentialStore } from '../src/adapters/credential-store.js'
import { createConfigurationService } from '../src/configuration.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, mkdir: vi.fn(fs.mkdir) }
})

const homes: string[] = []
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

async function fixture(
  model: string | string[],
  status = 200,
): Promise<{ baseUrl: string; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = []
  const server = createServer((request, response) => {
    requests.push(request)
    if (request.url !== '/v1/models') {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [model].flat().map((id) => ({ id })) }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests }
}

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'agnes-config-'))
  homes.push(value)
  const root = join(value, 'home')
  createPrivateDirectorySync(root)
  return root
}

it('tests a real provider catalogue, saves an atomic non-secret record, and exposes the Host overlay', async () => {
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('openai registry entry missing')
  const adapter = await entry.createAdapter()
  const model = adapter.models(entry.route)[0]?.id
  if (!model) throw new Error('openai catalogue is empty')
  const server = await fixture(model)
  const root = await home()
  if (process.getuid) await chmod(root, 0o755) // Fresh custom home under the normal POSIX umask.
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  expect(await service.profileInput()).toEqual({})

  const result = await service.test({
    providerId: 'openai',
    baseUrl: server.baseUrl,
    apiKey: 'sk-test-value',
  })
  expect(result).toMatchObject({
    models: [
      {
        id: model,
        name: expect.any(String),
        contextWindow: expect.any(Number),
        reasoning: expect.any(Boolean),
      },
    ],
    verified: true,
  })
  const capacity = result.models[0]?.contextWindow
  if (!capacity) throw new Error('model capacity missing')
  const defaultSettings = { contextWindow: Math.floor(capacity / 2) }
  expect(requestsHeaders(server.requests)[0]?.authorization).toBe('Bearer sk-test-value')

  const saved = await service.save({
    providerId: 'openai',
    baseUrl: server.baseUrl,
    apiKey: 'sk-test-value',
    model,
    expectedRevision: 0,
    defaultSettings,
    networkTimeouts: { requestMs: 90000, connectMs: 4000, streamIdleMs: 15000 },
  })
  if (process.getuid) expect((await lstat(root)).mode & 0o7777).toBe(0o700)
  expect(saved).toMatchObject({ profile: 'local-dev', revision: 1, configured: true, effect: 'new-sessions' })
  expect(await service.get()).toEqual(saved)
  expect(saved.accounts?.[0]?.models[0]?.defaultSettings).toEqual(defaultSettings)
  expect(saved.accounts?.[0]?.networkTimeouts).toEqual({
    requestMs: 90000,
    connectMs: 4000,
    streamIdleMs: 15000,
  })

  const overlay = await service.profileInput()
  expect(overlay.provider?.catalog).toEqual({ include: [] })
  expect(overlay.adapters?.secrets).toEqual({ kind: 'file', path: join(root, 'secrets') })
  expect(overlay.provider?.routes?.[0]).toMatchObject({
    route: 'openai',
    baseUrl: server.baseUrl,
  })
  expect(overlay.provider?.routes?.[0]?.models?.[0]?.defaultSettings).toEqual(defaultSettings)
  const ref = overlay.provider?.routes?.[0]?.credentialRef
  expect(ref).toMatch(/^secret:\/\/openai\/account-[0-9a-f]{24}-r1$/)
  expect(JSON.stringify(overlay)).not.toContain('sk-test-value')
  const persisted = await readFile(join(root, 'profiles', 'local-dev', 'configuration.json'), 'utf8')
  expect(persisted).not.toContain('sk-test-value')
  if (!ref) throw new Error('profile overlay omitted credential ref')
  await expect(createCredentialStore({ root }).read(ref)).resolves.toMatchObject({
    kind: 'api-key',
    provider: 'openai',
    value: 'sk-test-value',
  })

  const other = createConfigurationService({ home: root, profile: 'local-dev' })
  for (const networkTimeouts of [
    { connectMs: 0 },
    { requestMs: 1.5 },
    { streamIdleMs: 3600001 },
    { unknown: 1 },
    null,
  ])
    await expect(
      service.save({ providerId: 'openai', model, networkTimeouts: networkTimeouts as never }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  const second = await service.save({ providerId: 'openai', model, expectedRevision: 1 })
  expect(second.accounts?.[0]?.networkTimeouts).toEqual(saved.accounts?.[0]?.networkTimeouts)
  expect(JSON.stringify(await service.profileInput())).toContain('networkTimeouts')
  expect(second.revision).toBe(2)
  expect(second.accounts?.[0]?.models[0]?.defaultSettings).toEqual(defaultSettings)
  await expect(other.get()).resolves.toMatchObject({ revision: 2, configured: true })
  const secondRef = (await service.profileInput()).provider?.routes?.[0]?.credentialRef
  expect(secondRef).toMatch(/^secret:\/\/openai\/account-[0-9a-f]{24}-r2$/)
  expect(secondRef).not.toBe(ref)
  await expect(createCredentialStore({ root }).read(ref)).resolves.toMatchObject({ value: 'sk-test-value' })
  for (const invalid of [
    { contextWindow: capacity + 1 },
    { contextWindow: 1.5 },
    { contextWindow: 100 },
    { thinking: 'unknown' },
    { thinking: 'high' },
  ]) {
    await expect(
      service.save({ providerId: 'openai', model, defaultSettings: invalid as never }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
    expect((await service.get()).revision).toBe(2)
  }
  const reset = await service.save({ providerId: 'openai', model, defaultSettings: {}, expectedRevision: 2 })
  expect(reset.accounts?.[0]?.models[0]?.defaultSettings).toEqual({})
  const beforeSelection = await service.get()
  const selection = { providers: { loop: { provider: 'workflow', version: '1.0.0' } } }
  const selected = await service.saveSessionDefaults({
    revision: beforeSelection.revision,
    defaults: selection,
  })
  await service.save({ providerId: 'openai', model, expectedRevision: selected.revision })
  expect((await service.sessionDefaults()).defaults).toEqual(selection)
})

it('discovers, saves and reloads the current DeepSeek Flash id', async () => {
  const server = await fixture('deepseek-flash')
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  const input = { providerId: 'deepseek', baseUrl: server.baseUrl, apiKey: 'sk-test-value' }
  expect(await service.test(input)).toMatchObject({
    models: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }],
    verified: true,
  })
  const defaultSettings = { thinking: 'low' as const, contextWindow: 64000 }
  await service.save({ ...input, model: 'deepseek-flash', defaultSettings, expectedRevision: 0 })
  const reloaded = createConfigurationService({ home: root, profile: 'local-dev' })
  expect((await reloaded.profileInput()).provider?.routes?.[0]?.models).toEqual([
    expect.objectContaining({ id: 'deepseek-flash', input: ['text', 'image'], defaultSettings }),
  ])
})

it('tests Kimi Coding Plan through its OpenAI-compatible catalogue and fails closed on unknown models', async () => {
  const entry = getApiKeyProvider('kimi-coding')
  if (!entry) throw new Error('kimi-coding registry entry missing')
  const model = (await entry.createAdapter()).models(entry.route).find(({ id }) => id === 'kimi-for-coding')
  if (!model) throw new Error('kimi-coding catalogue is missing kimi-for-coding')
  const requests: Request[] = []
  let offeredModel = model.id
  const request: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init))
    return new Response(JSON.stringify({ data: [{ id: offeredModel }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const service = createConfigurationService({ home: await home(), profile: 'local-dev', request })

  await expect(service.providers()).resolves.toEqual(
    expect.objectContaining({
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: 'kimi-coding',
          label: 'Kimi Coding Plan',
          api: 'openai-completions',
          baseUrl: 'https://api.kimi.com/coding/v1',
          authMethods: ['api-key', 'oauth'],
          loginMethods: ['device_code'],
        }),
      ]),
    }),
  )

  await expect(service.test({ providerId: 'kimi-coding', apiKey: 'kimi-test-value' })).resolves.toMatchObject(
    {
      models: [{ id: model.id, name: model.name }],
      verified: true,
    },
  )
  expect(requests[0]?.url).toBe('https://api.kimi.com/coding/v1/models')
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer kimi-test-value')
  expect(requests[0]?.headers.get('x-api-key')).toBeNull()
  expect(requests[0]?.headers.get('anthropic-version')).toBeNull()

  offeredModel = 'unreviewed-kimi-model'
  await expect(service.test({ providerId: 'kimi-coding', apiKey: 'kimi-test-value' })).resolves.toMatchObject(
    { models: expect.any(Array), verified: false },
  )
})

it('reads a saved Kimi Coding row at the pre-1.3 default address as the current default, leaving custom addresses alone', async () => {
  const entry = getApiKeyProvider('kimi-coding')
  if (!entry) throw new Error('kimi-coding registry entry missing')
  const model = 'kimi-for-coding'
  const request: typeof fetch = async () =>
    new Response(JSON.stringify({ data: [{ id: model }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev', request })
  await service.save({ providerId: 'kimi-coding', apiKey: 'kimi-test-value', model })
  const configPath = await savedModelPath(root)
  const rewrite = async (baseUrl: string) => {
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as { accounts: Array<{ baseUrl: string }> }
    for (const row of stored.accounts) row.baseUrl = baseUrl
    await writeFile(configPath, JSON.stringify(stored))
    return createConfigurationService({ home: root, profile: 'local-dev', request })
  }

  for (const legacy of ['https://api.kimi.com/coding', 'https://api.kimi.com/coding/']) {
    const reloaded = await rewrite(legacy)
    expect((await reloaded.get()).provider?.baseUrl).toBe('https://api.kimi.com/coding/v1')
    expect((await reloaded.profileInput()).provider?.routes?.[0]).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://api.kimi.com/coding/v1',
    })
  }

  const custom = 'https://kimi-gateway.example.test/coding/v1'
  expect((await (await rewrite(custom)).get()).provider?.baseUrl).toBe(custom)
})

it('keeps the payload-only provider out of the chat account form projection', async () => {
  const service = createConfigurationService({ home: await home(), profile: 'local-dev' })
  const { providers } = await service.providers()
  expect(providers.some((provider) => provider.id === 'typesafe-systemone')).toBe(false)
  expect(getApiKeyProvider('typesafe-systemone')?.capabilities?.payloadOnly).toBe(true)
})

it('connects an OpenAI-compatible endpoint with its own model ids, with or without a key, over chat completions', async () => {
  const server = await fixture([
    'my-model',
    'agnes-image-2.5-flash',
    'agnes-video-1.0',
    'relay/agnes-image-2.5-flash',
    'qwen-plus',
  ])
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  expect((await service.providers()).providers.some((row) => row.id === 'openai-compatible')).toBe(true)
  const compatible = { providerId: 'openai-compatible', baseUrl: server.baseUrl }
  const listed = { id: 'my-model', name: 'my-model', contextWindow: 128000, maxTokens: 8192 }
  // No intersection with a reviewed catalogue, and no key needed to list.
  expect(await service.test(compatible)).toEqual({
    models: [listed, { ...listed, id: 'qwen-plus', name: 'qwen-plus' }],
    verified: true,
  })
  expect(requestsHeaders(server.requests)[0]?.authorization).toBeUndefined()
  for (const model of ['agnes-image-2.5-flash', 'agnes-video-1.0', 'relay/agnes-image-2.5-flash']) {
    await expect(
      service.save({ ...compatible, model, models: [{ id: model, name: model }] }),
    ).rejects.toMatchObject({ code: 'CONFIG_CHAT_MODEL_REQUIRED' })
  }
  // The OpenAI provider on the same address keeps its reviewed-catalogue rule.
  expect(
    await service.test({ providerId: 'openai', baseUrl: server.baseUrl, apiKey: 'sk-test-value' }),
  ).toMatchObject({ verified: false })
  // The stand-in default is not an address; a listing failure says why and is not an error.
  await expect(service.test({ providerId: 'openai-compatible' })).rejects.toMatchObject({
    code: 'CONFIG_INVALID_INPUT',
    field: 'baseUrl',
  })
  const bare = server.baseUrl.replace(/\/v1$/, '')
  expect(await service.test({ ...compatible, baseUrl: bare })).toEqual({
    models: [],
    verified: false,
    catalogueError: { reason: 'http', status: 404 },
  })

  // A hand-typed model saves although nothing listed it, and no key is stored as no key.
  const saved = await service.save({
    ...compatible,
    baseUrl: bare,
    accountId: 'relay',
    label: 'Relay',
    model: 'hand-typed',
    models: [{ id: 'hand-typed', name: 'hand-typed' }],
    expectedRevision: 0,
  })
  expect(saved.accounts?.[0]).toMatchObject({
    providerId: 'openai-compatible',
    model: 'hand-typed',
    models: [{ id: 'hand-typed', name: 'hand-typed', contextWindow: 128000, maxTokens: 8192 }],
    credentialConfigured: true,
  })
  expect(saved.defaultAccountId).toBe('relay')
  await expect(
    service.saveSessionDefaults({
      revision: 1,
      defaults: {
        providers: { 'model-adapter': { provider: 'pi', version: '1.0.0' } },
        model: 'agnes-image-2.5-flash',
      },
    }),
  ).rejects.toMatchObject({ code: 'CONFIG_CHAT_MODEL_REQUIRED' })
  await expect(
    service.saveModelSlots({
      revision: 1,
      slots: { fast: { route: 'account-relay', model: 'agnes-image-2.5-flash' } },
    }),
  ).rejects.toMatchObject({ code: 'CONFIG_CHAT_MODEL_REQUIRED' })
  // Without models, a save takes what the endpoint lists; a key goes on the request.
  await service.save({
    ...compatible,
    accountId: 'keyed',
    label: 'Keyed',
    apiKey: 'sk-relay',
    model: 'qwen-plus',
    expectedRevision: 1,
  })
  expect(requestsHeaders(server.requests).at(-1)?.authorization).toBe('Bearer sk-relay')
  await expect(
    service.save({ ...compatible, accountId: 'other', model: 'absent', expectedRevision: 2 }),
  ).rejects.toMatchObject({ code: 'CONFIG_MODEL_UNAVAILABLE' })

  const reopened = createConfigurationService({ home: root, profile: 'local-dev' })
  // Re-listing a keyless account sends no key either.
  await reopened.test({ ...compatible, accountId: 'relay', baseUrl: bare })
  expect(requestsHeaders(server.requests).at(-1)?.authorization).toBeUndefined()
  const routes = (await reopened.profileInput()).provider?.routes ?? []
  expect(routes.map((row) => [row.route, row.api, row.baseUrl])).toEqual([
    ['account-relay', 'openai-completions', bare],
    ['account-keyed', 'openai-completions', server.baseUrl],
  ])
  expect(routes[0]?.models?.[0]).toMatchObject({
    id: 'hand-typed',
    api: 'openai-completions',
    reasoning: false,
    input: ['text'],
    toolCallFormats: ['native'],
    thinkingReplay: 'drop',
    contextWindow: 128000,
    maxTokens: 8192,
  })
  expect(routes[1]?.models?.map((model) => model.id)).toEqual(['qwen-plus', 'my-model'])
  const keyed = routes[1]?.credentialRef
  if (!keyed) throw new Error('keyed route has no credential')
  await expect(createCredentialStore({ root }).read(keyed)).resolves.toMatchObject({ value: 'sk-relay' })

  // A keyless account has no key to protect: it moves to another address without one.
  const moved = { ...compatible, accountId: 'relay', model: 'my-model', models: [listed] }
  await expect(reopened.test({ ...compatible, accountId: 'relay' })).resolves.toMatchObject({
    verified: true,
  })
  expect(requestsHeaders(server.requests).at(-1)?.authorization).toBeUndefined()
  expect((await reopened.save({ ...moved, expectedRevision: 2 })).accounts?.[0]).toMatchObject({
    baseUrl: server.baseUrl,
    credentialConfigured: true,
  })
  // An older account may already contain a generation model; never publish it into chat routes.
  const path = join(root, 'profiles', 'local-dev', 'configuration.json')
  const before = await readFile(path, 'utf8')
  const state = JSON.parse(before)
  state.accounts[0].model = 'agnes-image-2.5-flash'
  state.accounts[0].models = [{ id: 'agnes-image-2.5-flash', name: 'Image' }]
  state.sessionDefaults = {
    providers: { 'model-adapter': { provider: 'pi', version: '1.0.0' } },
    model: 'agnes-image-2.5-flash',
  }
  state.modelSlots = { fast: { route: 'account-relay', model: 'agnes-video-1.0' } }
  await writeFile(path, JSON.stringify(state))
  expect((await reopened.get()).accounts?.[0]?.models).toEqual([])
  await expect(reopened.profileInput()).rejects.toMatchObject({ code: 'CONFIG_CHAT_MODEL_REQUIRED' })
  await expect(reopened.sessionDefaults()).rejects.toMatchObject({ code: 'CONFIG_CHAT_MODEL_REQUIRED' })
  await expect(reopened.modelSlots()).rejects.toMatchObject({ code: 'CONFIG_CHAT_MODEL_REQUIRED' })
  await writeFile(path, before)
  // A real key never follows the account to a new address unasked.
  await expect(
    reopened.save({ ...moved, accountId: 'keyed', baseUrl: bare, expectedRevision: 3 }),
  ).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REQUIRED', field: 'apiKey' })
})

it('refuses a rejected key while listing an OpenAI-compatible endpoint', async () => {
  const server = await fixture('my-model', 401)
  const service = createConfigurationService({ home: await home(), profile: 'local-dev' })
  await expect(
    service.test({ providerId: 'openai-compatible', baseUrl: server.baseUrl, apiKey: 'sk-bad' }),
  ).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REJECTED' })
})

const JEV_MODEL = {
  id: 'typesafe/jev-1.13-20260917',
  name: 'Jev 1.13 (2026-09-17)',
  contextWindow: 65536,
  maxTokens: 32768,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
}

async function genericCredential(root: string, value = 'jev-test-key'): Promise<string> {
  const ref = 'secret://generic/11111111-1111-4111-8111-111111111111'
  await createCredentialStore({ root }).putGeneric(ref, value, {
    label: 'Jev',
    createdAt: '2026-10-16T00:00:00.000Z',
  })
  return ref
}

const jevAccount = (credentialRef?: string) => ({
  providerId: 'typesafe-systemone',
  accountId: 'jev',
  label: 'Jev',
  ...(credentialRef === undefined ? {} : { credentialRef }),
  model: JEV_MODEL.id,
  models: [JEV_MODEL],
})

it('saves a payload-only account bound to a generic credential and renders its route from the fixed template', async () => {
  const root = await home()
  const ref = await genericCredential(root)
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  const saved = await service.save({
    ...jevAccount(ref),
    models: [
      JEV_MODEL,
      { id: 'typesafe/jev-1.12-20260801', name: 'Jev 1.12', contextWindow: 65536, maxTokens: 32768 },
    ],
    expectedRevision: 0,
  })
  expect(saved).toMatchObject({ revision: 1, configured: false, defaultAccountId: null })
  expect(saved.accounts?.[0]).toMatchObject({
    accountId: 'jev',
    providerId: 'typesafe-systemone',
    route: 'account-jev',
    baseUrl: 'https://openrouter.ai/api/v1',
    credentialConfigured: true,
    enabled: true,
  })
  expect(JSON.stringify(saved)).not.toContain('jev-test-key')

  const overlay = await service.profileInput()
  expect(overlay.provider?.routes).toEqual([
    {
      route: 'account-jev',
      api: 'typesafe-systemone',
      baseUrl: 'https://openrouter.ai/api/v1',
      credentialRef: ref,
      displayName: 'Jev',
      models: [
        {
          id: JEV_MODEL.id,
          name: JEV_MODEL.name,
          api: 'typesafe-systemone',
          route: 'account-jev',
          baseUrl: 'https://openrouter.ai/api/v1',
          reasoning: false,
          input: ['text'],
          cost: JEV_MODEL.cost,
          contextWindow: 65536,
          maxTokens: 32768,
          toolCallFormats: [],
          thinkingReplay: 'drop',
          contract_id: null,
        },
        {
          id: 'typesafe/jev-1.12-20260801',
          name: 'Jev 1.12',
          api: 'typesafe-systemone',
          route: 'account-jev',
          baseUrl: 'https://openrouter.ai/api/v1',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 65536,
          maxTokens: 32768,
          toolCallFormats: [],
          thinkingReplay: 'drop',
          contract_id: null,
        },
      ],
    },
  ])
  const reloaded = createConfigurationService({ home: root, profile: 'local-dev' })
  expect(await reloaded.profileInput()).toEqual(overlay)

  // A hand-written profile-layer route of the same name is refused at merge, as for any account route.
  expect(() =>
    mergeRoutes(
      overlay.provider?.routes,
      [{ route: 'account-jev', api: 'typesafe-systemone', baseUrl: 'https://x.invalid' }],
      'local',
    ),
  ).toThrow(/E_PRESET_UNRESOLVED/)

  // Losing the bound credential excludes the route without blocking the settings surface.
  await createCredentialStore({ root }).remove(ref)
  expect((await service.profileInput()).provider?.routes).toEqual([])
  expect((await service.get()).accounts?.[0]).toMatchObject({
    credentialConfigured: false,
    credentialIssue: 'CONFIG_CREDENTIAL_REQUIRED',
  })
})

it('accepts a direct endpoint for a payload-only account and rejects chat-form fields', async () => {
  const root = await home()
  const ref = await genericCredential(root)
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  const saved = await service.save({
    ...jevAccount(ref),
    baseUrl: 'https://api.typesafe.ai/v1',
    expectedRevision: 0,
  })
  expect(saved.accounts?.[0]?.baseUrl).toBe('https://api.typesafe.ai/v1')

  const malformed = [
    { ...jevAccount(ref), makeDefault: true },
    { ...jevAccount(ref), apiKey: 'jev-test-key' },
    { ...jevAccount(ref), defaultSettings: { contextWindow: 32000 } },
    { ...jevAccount(ref), models: [] },
    { ...jevAccount(ref), models: [JEV_MODEL, JEV_MODEL] },
    { ...jevAccount(ref), models: [{ ...JEV_MODEL, reasoning: true }] },
    { ...jevAccount(ref), models: [{ id: JEV_MODEL.id, name: JEV_MODEL.name, contextWindow: 65536 }] },
    { ...jevAccount(ref), models: [{ ...JEV_MODEL, maxTokens: 0 }] },
    { ...jevAccount(ref), models: [{ ...JEV_MODEL, cost: { input: 0 } }] },
    { ...jevAccount(ref), credentialRef: 'secret://openai/default' },
  ]
  for (const input of malformed)
    await expect(service.save(input as never)).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  await expect(service.save({ ...jevAccount(ref), model: 'typesafe/jev-9.99' })).rejects.toMatchObject({
    code: 'CONFIG_MODEL_UNAVAILABLE',
  })
  expect((await service.get()).revision).toBe(1)

  // Chat accounts keep their exact input surface: the new fields are not accepted there.
  const server = await fixture('deepseek-flash')
  await expect(
    service.save({
      providerId: 'deepseek',
      baseUrl: server.baseUrl,
      apiKey: 'sk-test-value',
      model: 'deepseek-flash',
      models: [JEV_MODEL],
    } as never),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
})

it('probes a payload-only endpoint with a fixed payload, treating success and throttling as reachable', async () => {
  const requests: Request[] = []
  let status = 200
  const request: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init))
    if (status === 200)
      return new Response(
        JSON.stringify({
          model: JEV_MODEL.id,
          answers: { ping: { answer: 'pong' } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    return new Response('', { status })
  }
  const root = await home()
  const ref = await genericCredential(root)
  const service = createConfigurationService({ home: root, profile: 'local-dev', request })
  await service.save({ ...jevAccount(ref), expectedRevision: 0 })

  const probed = await service.test({ providerId: 'typesafe-systemone', accountId: 'jev' })
  expect(probed).toMatchObject({ verified: true })
  expect(probed.models).toEqual([expect.objectContaining({ id: JEV_MODEL.id, maxTokens: 32768 })])
  const sent = requests[0]
  if (!sent) throw new Error('probe sent no request')
  expect(sent.method).toBe('POST')
  expect(sent.url).toBe('https://openrouter.ai/api/v1/systemone')
  expect(sent.headers.get('authorization')).toBe('Bearer jev-test-key')
  expect(await sent.json()).toEqual({ model: JEV_MODEL.id, state: {}, questions: { ping: 'ping' } })

  // A probe of an unsaved entry binds the named generic credential, and no credential means untested.
  await expect(
    service.test({ providerId: 'typesafe-systemone', credentialRef: ref, model: JEV_MODEL.id }),
  ).resolves.toMatchObject({ models: [], verified: true })
  await expect(
    service.test({ providerId: 'typesafe-systemone', model: JEV_MODEL.id }),
  ).resolves.toMatchObject({ verified: false })

  // Throttling still proves reachability; a rejected key is the existing fixed refusal; a reply that
  // does not speak the protocol is not reachable and never blocks saving.
  status = 429
  await expect(service.test({ providerId: 'typesafe-systemone', accountId: 'jev' })).resolves.toMatchObject({
    verified: true,
  })
  status = 401
  await expect(service.test({ providerId: 'typesafe-systemone', accountId: 'jev' })).rejects.toMatchObject({
    code: 'CONFIG_CREDENTIAL_REJECTED',
  })
  status = 400
  await expect(service.test({ providerId: 'typesafe-systemone', accountId: 'jev' })).resolves.toMatchObject({
    verified: false,
  })

  // An edited endpoint is never probed with the stored reference implicitly, and the fields the
  // other side of the form owns stay refused.
  await expect(
    service.test({
      providerId: 'typesafe-systemone',
      accountId: 'jev',
      baseUrl: 'https://api.typesafe.ai/v1',
    }),
  ).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REQUIRED' })
  await expect(
    service.test({ providerId: 'typesafe-systemone', apiKey: 'jev-test-key' }),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  await expect(service.test({ providerId: 'deepseek', credentialRef: ref })).rejects.toMatchObject({
    code: 'CONFIG_INVALID_INPUT',
  })
})

it('refuses a payload-only account without a usable generic credential', async () => {
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  await expect(service.save(jevAccount())).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REQUIRED' })
  await expect(
    service.save(jevAccount('secret://generic/99999999-9999-4999-8999-999999999999')),
  ).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REQUIRED' })
  expect((await service.get()).revision).toBe(0)
})

it.each([
  'http://localhost/v1',
  'https://replacement.example.invalid/v1',
  'https://localhost:9443/v1',
  'https://localhost/v2',
])('requires an explicit credential before saving a changed endpoint %s', async (baseUrl) => {
  const root = await home()
  const ref = await genericCredential(root)
  const request = vi.fn<typeof fetch>(async () => new Response('', { status: 429 }))
  const service = createConfigurationService({ home: root, profile: 'local-dev', request })
  const saved = await service.save({ ...jevAccount(ref), baseUrl: 'https://localhost/v1' })
  await expect(service.save({ ...jevAccount(), baseUrl, expectedRevision: 1 })).rejects.toMatchObject({
    code: 'CONFIG_CREDENTIAL_REQUIRED',
    field: 'credentialRef',
  })
  expect(await service.get()).toEqual(saved)
  expect(request).not.toHaveBeenCalled()
  await expect(
    service.save({
      ...jevAccount(),
      baseUrl: `${saved.accounts?.[0]?.baseUrl}/`,
      label: 'Renamed',
      expectedRevision: 1,
    }),
  ).resolves.toMatchObject({ revision: 2 })
  await expect(service.save({ ...jevAccount(ref), baseUrl, expectedRevision: 2 })).resolves.toMatchObject({
    revision: 3,
  })
  await service.test({ providerId: 'typesafe-systemone', accountId: 'jev' })
  expect(new Request(request.mock.calls[0]?.[0] ?? '', request.mock.calls[0]?.[1]).url).toBe(
    `${baseUrl}/systemone`,
  )
})

it.each([
  'http://vendor.example.invalid/v1',
  'https://vendor.example.invalid/{tenant}',
  'https://vendor.example.invalid/v1?',
])('refuses an unusable payload-only URL %s without persisting it', async (baseUrl) => {
  const root = await home()
  const ref = await genericCredential(root)
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  await expect(service.save({ ...jevAccount(ref), baseUrl })).rejects.toMatchObject({
    code: 'CONFIG_INVALID_INPUT',
    field: 'baseUrl',
  })
  expect((await service.get()).revision).toBe(0)
  expect(await service.profileInput()).toEqual({})
  await expect(
    service.save({ ...jevAccount(ref), baseUrl: 'https://vendor.example.invalid/v1' }),
  ).resolves.toMatchObject({ revision: 1 })
  // Old records still load, but cannot be saved or probed with an unusable effective URL.
  const path = join(root, 'profiles', 'local-dev', 'configuration.json')
  const state = JSON.parse(await readFile(path, 'utf8'))
  state.accounts[0].baseUrl = baseUrl
  await writeFile(path, JSON.stringify(state))
  expect((await service.get()).revision).toBe(1)
  await expect(service.save({ ...jevAccount(), expectedRevision: 1 })).rejects.toMatchObject({
    code: 'CONFIG_INVALID_INPUT',
    field: 'baseUrl',
  })
  await expect(service.test({ providerId: 'typesafe-systemone', accountId: 'jev' })).rejects.toMatchObject({
    code: 'CONFIG_INVALID_INPUT',
    field: 'baseUrl',
  })
  expect(await readFile(path, 'utf8')).toBe(JSON.stringify(state))
})

it.each(['http://localhost/v1', 'http://127.0.0.2/v1', 'http://[::1]/v1'])(
  'preserves the adapter loopback HTTP allowance for %s',
  async (baseUrl) => {
    const root = await home()
    const ref = await genericCredential(root)
    await expect(
      createConfigurationService({ home: root, profile: 'local-dev' }).save({ ...jevAccount(ref), baseUrl }),
    ).resolves.toMatchObject({ revision: 1 })
  },
)

it('never lets a payload-only account become the default account', async () => {
  const server = await fixture('deepseek-flash')
  const root = await home()
  const ref = await genericCredential(root)
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  await service.save({
    providerId: 'deepseek',
    baseUrl: server.baseUrl,
    apiKey: 'sk-test-value',
    model: 'deepseek-flash',
    expectedRevision: 0,
  })
  const saved = await service.save({ ...jevAccount(ref), expectedRevision: 1 })
  expect(saved.defaultAccountId).toBe('legacy-deepseek')
  await expect(
    service.save({ ...jevAccount(ref), makeDefault: true, expectedRevision: 2 }),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  await expect(
    service.account({ accountId: 'jev', action: 'default', expectedRevision: 2 }),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })

  // Removing the chat default leaves no default rather than promoting the payload-only account.
  const removed = await service.account({
    accountId: 'legacy-deepseek',
    action: 'remove',
    expectedRevision: 2,
  })
  expect(removed.defaultAccountId).toBeNull()
  const reloaded = createConfigurationService({ home: root, profile: 'local-dev' })
  expect((await reloaded.get()).defaultAccountId).toBeNull()
  expect((await reloaded.profileInput()).provider?.routes?.[0]?.api).toBe('typesafe-systemone')

  // Enable and disable work, but neither makes the account the default.
  await service.account({ accountId: 'jev', action: 'disable', expectedRevision: 3 })
  expect((await service.profileInput()).provider?.routes).toEqual([])
  const enabled = await service.account({ accountId: 'jev', action: 'enable', expectedRevision: 4 })
  expect(enabled.defaultAccountId).toBeNull()
  expect((await service.profileInput()).provider?.routes).toHaveLength(1)
})

it('saves and reopens from a previously nonexistent nested home without read-side creation', async () => {
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('openai registry entry missing')
  const model = (await entry.createAdapter()).models(entry.route)[0]?.id
  if (!model) throw new Error('openai catalogue is empty')
  const server = await fixture(model)
  const root = join(await home(), 'new-parent', 'new-home')
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  expect(await service.profileInput()).toEqual({})
  await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(
    service.save({ providerId: 'openai', baseUrl: server.baseUrl, apiKey: 'first', model }),
  ).resolves.toMatchObject({
    revision: 1,
  })
  await expect(
    createConfigurationService({ home: root, profile: 'local-dev' }).profileInput(),
  ).resolves.toMatchObject({
    adapters: { secrets: { kind: 'file', path: join(root, 'secrets') } },
  })
})

it('keeps the saved configuration when replacement fails and allows a retry', async () => {
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('openai registry entry missing')
  const model = (await entry.createAdapter()).models(entry.route)[0]?.id
  if (!model) throw new Error('openai catalogue is empty')
  const server = await fixture(model)
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  await service.save({ providerId: 'openai', baseUrl: server.baseUrl, apiKey: 'first', model })
  const file = join(root, 'profiles', 'local-dev', 'configuration.json')
  const before = await readFile(file, 'utf8')
  const replace = systemNode.renameWriteThrough
  const fault = vi
    .spyOn(systemNode, 'renameWriteThrough')
    .mockImplementation(async (source, target, options) => {
      if (target === file) throw Object.assign(new Error('injected replacement failure'), { code: 'EACCES' })
      return replace(source, target, options)
    })
  await expect(service.save({ providerId: 'openai', model, expectedRevision: 1 })).rejects.toMatchObject({
    code: 'CONFIG_PERSIST_FAILED',
  })
  expect(await readFile(file, 'utf8')).toBe(before)
  expect(fault).toHaveBeenCalledWith(expect.any(String), file, { noFollow: true })
  await expect(createConfigurationService({ home: root, profile: 'local-dev' }).get()).resolves.toMatchObject(
    {
      revision: 1,
      configured: true,
    },
  )
  fault.mockRestore()
  await expect(service.save({ providerId: 'openai', model, expectedRevision: 1 })).resolves.toMatchObject({
    revision: 2,
  })
})

it.each([401, 403])(
  'keeps the prior revision after an HTTP %i probe and rejects non-compatible endpoint overrides',
  async (status) => {
    const entry = getApiKeyProvider('openai')
    if (!entry) throw new Error('openai registry entry missing')
    const model = (await entry.createAdapter()).models(entry.route)[0]?.id
    if (!model) throw new Error('openai catalogue is empty')
    const server = await fixture(model, status)
    const root = await home()
    const service = createConfigurationService({ home: root, profile: 'local-dev' })
    await expect(
      service.save({ providerId: 'openai', baseUrl: server.baseUrl, apiKey: 'sk-test-value', model }),
    ).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REJECTED' })
    await expect(
      service.test({ providerId: 'openai', baseUrl: server.baseUrl, apiKey: 'sk-test-value' }),
    ).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REJECTED' })
    await expect(service.get()).resolves.toMatchObject({ revision: 0, configured: false, provider: null })
    await expect(
      service.test({ providerId: 'anthropic', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test-value' }),
    ).rejects.toMatchObject({ code: 'CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED' })
  },
)

it('probes the provider default after replacing a saved custom endpoint', async () => {
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('openai registry entry missing')
  const model = (await entry.createAdapter()).models(entry.route)[0]?.id
  if (!model) throw new Error('openai catalogue is empty')
  const requested: string[] = []
  const request: typeof fetch = async (input) => {
    requested.push(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url)
    return new Response(JSON.stringify({ data: [{ id: model }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev', request })
  const customBaseUrl = 'https://gateway.example/v1'
  const modelsEndpoint = (baseUrl: string): string => `${baseUrl.replace(/\/$/, '')}/models`

  await service.save({
    providerId: entry.id,
    baseUrl: customBaseUrl,
    apiKey: 'sk-test-value',
    model,
    expectedRevision: 0,
  })
  expect(requested.at(-1)).toBe(modelsEndpoint(customBaseUrl))

  const restored = await service.save({
    providerId: entry.id,
    baseUrl: entry.baseUrl,
    apiKey: 'sk-test-value',
    model,
    expectedRevision: 1,
  })
  expect(requested.at(-1)).toBe(modelsEndpoint(entry.baseUrl))
  expect(restored.provider?.baseUrl).toBe(entry.baseUrl)
})

function requestsHeaders(requests: IncomingMessage[]): Array<Record<string, string | string[] | undefined>> {
  return requests.map((request) => request.headers)
}

async function savedModelPath(root: string): Promise<string> {
  return join(root, 'profiles', 'local-dev', 'configuration.json')
}

it("a declared thinkingEfforts object overrides the installed catalogue's reasoning capability", async () => {
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('openai registry entry missing')
  const model = (await entry.createAdapter()).models(entry.route)[0]?.id
  if (!model) throw new Error('openai catalogue is empty')
  const server = await fixture(model)
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  await service.save({ providerId: 'openai', baseUrl: server.baseUrl, apiKey: 'sk-test-value', model })

  const configPath = await savedModelPath(root)
  const stored = JSON.parse(await readFile(configPath, 'utf8')) as {
    accounts: Array<{ models: Array<{ id: string; thinkingEfforts?: unknown }> }>
  }
  const row = stored.accounts[0]?.models.find((m) => m.id === model)
  if (!row) throw new Error('saved model missing from stored config')
  row.thinkingEfforts = { high: 'high' }
  await writeFile(configPath, JSON.stringify(stored))

  const reloaded = createConfigurationService({ home: root, profile: 'local-dev' })
  const overlay = await reloaded.profileInput()
  const resolved = overlay.provider?.routes?.[0]?.models?.find((m) => m.id === model)
  expect(resolved).toMatchObject({ reasoning: true, thinkingLevelMap: { high: 'high' } })
})

it('a declared thinkingEfforts: false forces off reasoning even for a catalogue model that claims it', async () => {
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('openai registry entry missing')
  const model = (await entry.createAdapter()).models(entry.route)[0]?.id
  if (!model) throw new Error('openai catalogue is empty')
  const server = await fixture(model)
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  await service.save({ providerId: 'openai', baseUrl: server.baseUrl, apiKey: 'sk-test-value', model })

  const configPath = await savedModelPath(root)
  const stored = JSON.parse(await readFile(configPath, 'utf8')) as {
    accounts: Array<{ models: Array<{ id: string; thinkingEfforts?: unknown }> }>
  }
  const row = stored.accounts[0]?.models.find((m) => m.id === model)
  if (!row) throw new Error('saved model missing from stored config')
  row.thinkingEfforts = false
  await writeFile(configPath, JSON.stringify(stored))

  const reloaded = createConfigurationService({ home: root, profile: 'local-dev' })
  const overlay = await reloaded.profileInput()
  const resolved = overlay.provider?.routes?.[0]?.models?.find((m) => m.id === model)
  expect(resolved?.reasoning).toBe(false)
  expect(Object.hasOwn(resolved ?? {}, 'thinkingLevelMap')).toBe(false)
})

it('an empty thinkingEfforts object is rejected as corrupt state, not silently treated as no override', async () => {
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('openai registry entry missing')
  const model = (await entry.createAdapter()).models(entry.route)[0]?.id
  if (!model) throw new Error('openai catalogue is empty')
  const server = await fixture(model)
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  await service.save({ providerId: 'openai', baseUrl: server.baseUrl, apiKey: 'sk-test-value', model })

  const configPath = await savedModelPath(root)
  const stored = JSON.parse(await readFile(configPath, 'utf8')) as {
    accounts: Array<{ models: Array<{ id: string; thinkingEfforts?: unknown }> }>
  }
  const row = stored.accounts[0]?.models.find((m) => m.id === model)
  if (!row) throw new Error('saved model missing from stored config')
  row.thinkingEfforts = {}
  await writeFile(configPath, JSON.stringify(stored))

  const reloaded = createConfigurationService({ home: root, profile: 'local-dev' })
  await expect(reloaded.profileInput()).rejects.toMatchObject({ code: 'CONFIG_INVALID_STATE' })
})

it('fails closed on a damaged configuration file, names it, and leaves it unchanged', async () => {
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('openai registry entry missing')
  const model = (await entry.createAdapter()).models(entry.route)[0]?.id
  if (!model) throw new Error('openai catalogue is empty')
  const server = await fixture(model)
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  await service.save({ providerId: 'openai', baseUrl: server.baseUrl, apiKey: 'sk-test-value', model })
  const configPath = await savedModelPath(root)
  await writeFile(configPath, '{"accounts":')

  const reloaded = createConfigurationService({ home: root, profile: 'local-dev' })
  const failure = await reloaded.profileInput().catch((error: unknown) => error)
  expect(failure).toMatchObject({ code: 'CONFIG_INVALID_STATE', file: configPath })
  expect((failure as Error).message).toContain(configPath)
  expect((failure as Error).message).toContain('left unchanged')
  expect(await readFile(configPath, 'utf8')).toBe('{"accounts":')
})

it('isolates two same-type accounts across disk reload, routes, credentials and account operations', async () => {
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('catalogue')
  const [m1, m2] = (await entry.createAdapter()).models(entry.route)
  if (!m1 || !m2) throw new Error('catalogue needs two models')
  const a = await fixture(m1.id),
    b = await fixture(m2.id)
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  const first = await service.save({
    accountId: 'work',
    label: 'Work',
    providerId: 'openai',
    baseUrl: a.baseUrl,
    apiKey: 'key-work',
    model: m1.id,
    expectedRevision: 0,
  })
  const oldProfile = await service.profileInput()
  const second = await service.save({
    accountId: 'personal',
    label: 'Personal',
    providerId: 'openai',
    baseUrl: b.baseUrl,
    apiKey: 'key-personal',
    model: m2.id,
    expectedRevision: first.revision,
  })
  expect(second.accounts).toHaveLength(2)
  expect(second.defaultAccountId).toBe('work')
  const reloaded = createConfigurationService({ home: root, profile: 'local-dev' })
  expect(await reloaded.get()).toEqual(second)
  const routes = (await reloaded.profileInput()).provider?.routes ?? []
  expect(routes.map((row) => [row.route, row.baseUrl, row.models?.[0]?.id])).toEqual([
    ['account-work', a.baseUrl, m1.id],
    ['account-personal', b.baseUrl, m2.id],
  ])
  expect(new Set(routes.map((row) => row.credentialRef)).size).toBe(2)
  expect(JSON.stringify(second)).not.toMatch(/key-work|key-personal|secret:\/\//)
  await service.test({ accountId: 'work', providerId: 'openai' })
  await service.test({ accountId: 'personal', providerId: 'openai' })
  expect(a.requests.at(-1)?.headers.authorization).toBe('Bearer key-work')
  expect(b.requests.at(-1)?.headers.authorization).toBe('Bearer key-personal')
  const requestsBefore = b.requests.length
  await expect(
    service.test({ accountId: 'work', providerId: 'openai', baseUrl: b.baseUrl }),
  ).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REQUIRED' })
  expect(b.requests).toHaveLength(requestsBefore)
  await expect(
    service.test({ accountId: 'fresh', providerId: 'openai', baseUrl: b.baseUrl }),
  ).resolves.toMatchObject({ verified: false })
  expect(b.requests).toHaveLength(requestsBefore)
  await expect(
    service.account({ accountId: 'work', action: 'remove', expectedRevision: 2 }),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  await expect(
    service.account({ accountId: 'personal', action: 'default', expectedRevision: 1 }),
  ).rejects.toMatchObject({ code: 'CONFIG_REVISION_CONFLICT' })
  const selected = await service.account({ accountId: 'personal', action: 'default', expectedRevision: 2 })
  expect(selected.provider?.route).toBe('account-personal')
  await service.account({ accountId: 'work', action: 'disable', expectedRevision: 3 })
  expect((await service.profileInput()).provider?.routes).toHaveLength(1)
  await service.account({ accountId: 'work', action: 'enable', expectedRevision: 4 })
  expect((await service.profileInput()).provider?.routes).toHaveLength(2)
  // Removing an account clears the auxiliary slots on its route, as clearing them in settings would:
  // fast goes back to following the default account, the verifier becomes an explicit "none".
  const personalVerifier = { route: 'account-personal', model: m2.id }
  await service.saveModelSlots({
    revision: 5,
    slots: { fast: { route: 'account-work', model: m1.id }, verifier: personalVerifier },
  })
  await service.account({ accountId: 'work', action: 'remove', expectedRevision: 6 })
  expect((await service.modelSlots()).slots).toEqual({ verifier: personalVerifier })
  const empty = await service.account({ accountId: 'personal', action: 'remove', expectedRevision: 7 })
  expect((await service.modelSlots()).slots).toEqual({ verifier: null })
  expect(empty).toMatchObject({ configured: false, accounts: [], defaultAccountId: null })
  expect(await reloaded.get()).toEqual(empty)
  // Existing sessions retain their immutable credential snapshot after configuration deletion.
  const ref = oldProfile.provider?.routes?.[0]?.credentialRef
  if (!ref) throw new Error('missing old ref')
  expect(await createCredentialStore({ root }).read(ref)).toMatchObject({ value: 'key-work' })
})

it('refuses a saved configuration in the removed single-provider format and leaves the file alone', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const root = await home()
  const profile = 'local-dev'
  const dir = join(root, 'profiles', profile),
    file = join(dir, 'configuration.json')
  await mkdir(dir, { recursive: true })
  const original = JSON.stringify({
    version: 1,
    profile,
    revision: 1,
    provider: {
      id: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      models: [{ id: 'gpt-test', name: 'Test' }],
    },
  })
  await writeFile(file, original)
  const service = createConfigurationService({ home: root, profile })
  await expect(service.get()).rejects.toMatchObject({ code: 'CONFIG_INVALID_STATE' })
  expect(await readFile(file, 'utf8')).toBe(original)
})

it('does not read a provider choice from the removed onboarding selection file', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const root = await home()
  const profile = 'local-dev'
  const dir = join(root, 'profiles', profile)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'onboarding-selection.json'),
    JSON.stringify({
      version: 1,
      profile,
      route: 'openai',
      model: 'gpt-test',
      thinking: 'off',
      credentialRef: 'x',
    }),
  )
  const service = createConfigurationService({ home: root, profile })
  expect((await service.get()).accounts ?? []).toEqual([])
})

it('refuses a retired permission-as-recipe default before saving', async () => {
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  await expect(
    service.saveSessionDefaults({ revision: 0, defaults: { preset: 'full-access' } }),
  ).rejects.toThrow(/Retired.*clean home/)
  expect(await service.sessionDefaults()).toEqual({ revision: 0, defaults: {} })
})

it('persists session defaults in existing configuration with cross-instance revision checks', async () => {
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  const defaults = {
    preset: 'minimal',
    permission: 'read-only' as const,
    providers: {
      loop: { provider: 'workflow', version: '1.0.0' },
      'model-adapter': { provider: 'adapter', version: '2.0.0' },
    },
    model: 'model',
  }
  expect(await service.sessionDefaults()).toEqual({ revision: 0, defaults: {} })
  await expect(service.saveSessionDefaults({ revision: 0, defaults })).resolves.toEqual({
    revision: 1,
    defaults,
  })
  const reloaded = createConfigurationService({ home: root, profile: 'local-dev' })
  expect(await reloaded.sessionDefaults()).toEqual({ revision: 1, defaults })
  expect(await reloaded.profileInput()).toEqual({})
  await expect(reloaded.saveSessionDefaults({ revision: 0, defaults: {} })).rejects.toMatchObject({
    code: 'CONFIG_REVISION_CONFLICT',
  })
  await expect(
    reloaded.saveSessionDefaults({
      revision: 1,
      defaults: { providers: { loop: { provider: '', version: '1' } } },
    }),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  await service.saveSessionDefaults({ revision: 1, defaults: {} })
  expect(await reloaded.sessionDefaults()).toEqual({ revision: 2, defaults: {} })
})

it('persists child engines beside session defaults and drops invalid fields', async () => {
  const { DISABLED_CHILD_ENGINES } = await import('@agnes/protocol')
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  const file = join(root, 'profiles', 'local-dev', 'configuration.json')
  const engines = structuredClone(DISABLED_CHILD_ENGINES)
  engines.codex = { ...engines.codex, enabled: true, command: 'codex', allow: ['codex'] }
  expect(await service.childEngines()).toEqual({ revision: 0, engines: DISABLED_CHILD_ENGINES })
  await expect(
    service.saveChildEngines({
      revision: 0,
      engines: { ...engines, codex: { ...engines.codex, command: '', allow: [] } },
    }),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  await expect(
    service.saveChildEngines({
      revision: 0,
      engines: { ...engines, codex: { ...engines.codex, allow: [] } },
    }),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  expect((await service.childEngines()).revision).toBe(0)
  await expect(service.saveChildEngines({ revision: 0, engines })).resolves.toEqual({ revision: 1, engines })
  await service.saveChildEngines({
    revision: 1,
    engines: {
      ...engines,
      codex: { ...engines.codex, env: { SECRET: 'super-secret' } },
    },
  } as never)
  expect(await readFile(file, 'utf8')).not.toContain('super-secret')
  await service.saveSessionDefaults({ revision: 2, defaults: { preset: 'minimal' } })
  expect((await service.childEngines()).engines.codex).toMatchObject({ enabled: true, allow: ['codex'] })
  await service.saveChildEngines({ revision: 3, engines })
  expect(await service.sessionDefaults()).toEqual({ revision: 4, defaults: { preset: 'minimal' } })
  const stored = JSON.parse(await readFile(file, 'utf8')) as { childEngines?: unknown }
  stored.childEngines = { broken: true }
  await writeFile(file, JSON.stringify(stored))
  const reloaded = createConfigurationService({ home: root, profile: 'local-dev' })
  expect(await reloaded.sessionDefaults()).toEqual({ revision: 4, defaults: { preset: 'minimal' } })
  expect((await reloaded.childEngines()).engines.codex.enabled).toBe(false)
  await expect(reloaded.saveChildEngines({ revision: 0, engines })).rejects.toMatchObject({
    code: 'CONFIG_REVISION_CONFLICT',
  })
})

it.runIf(process.getuid !== undefined).each([0o500, 0o755])(
  'refuses secrets directory mode %o with actionable errors and safe diagnostics',
  async (mode) => {
    const server = await fixture('deepseek-flash')
    const root = await home()
    const directory = join(root, 'secrets')
    await mkdir(directory, { mode })
    const service = createConfigurationService({ home: root, profile: 'local-dev' })
    const input = { providerId: 'deepseek', baseUrl: server.baseUrl, apiKey: 'sk-test-value' }
    await expect(
      service.save({ ...input, model: 'deepseek-flash', expectedRevision: 0 }),
    ).rejects.toMatchObject({
      code: 'CONFIG_CREDENTIAL_PERMISSIONS',
      message: expect.stringContaining('0700'),
      credential: {
        part: 'secrets',
        check: 'mode',
        mode: mode.toString(8).padStart(4, '0'),
        expectedMode: '0700',
      },
    })
    expect((await service.get()).revision).toBe(0)
    expect((await lstat(directory)).mode & 0o7777).toBe(mode)
    const audit = await readFile(join(root, 'data', 'audit', 'configuration.jsonl'), 'utf8')
    expect(audit).not.toContain(input.apiKey)
    expect(JSON.parse(audit.trim())).toMatchObject({
      kind: 'daemon.request_failed',
      detail: {
        operation: 'write',
        errorClass: 'CredentialStoreError',
        errorCode: 'CREDENTIAL_STORE_UNSAFE',
        reason: 'mode',
        path: directory,
      },
    })
    await chmod(directory, 0o700)
    await service.save({ ...input, model: 'deepseek-flash', expectedRevision: 0 })
    await chmod(directory, mode)
    expect((await service.get()).accounts?.[0]).toMatchObject({
      credentialConfigured: false,
      credentialIssue: 'CONFIG_CREDENTIAL_UNREADABLE',
    })
    expect((await service.profileInput()).provider?.routes).toEqual([])
    // An unavailable credential degrades reads only; writes retain their permission refusal.
    await expect(
      service.save({ ...input, model: 'deepseek-flash', expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_PERMISSIONS' })
    await service.get()
    const records = (await readFile(join(root, 'data', 'audit', 'configuration.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records.at(-1)).toMatchObject({ detail: { operation: 'read', path: directory, reason: 'mode' } })
    await chmod(directory, 0o700)
  },
)

it.runIf(process.getuid !== undefined).each([
  ['EROFS', 'CONFIG_CREDENTIAL_READ_ONLY'],
  ['EACCES', 'CONFIG_CREDENTIAL_PERMISSIONS'],
  ['ENOSPC', 'CONFIG_CREDENTIAL_NO_SPACE'],
])('reports %s without leaking exception text or publishing an account', async (osCode, code) => {
  const server = await fixture('deepseek-flash')
  const root = await home()
  const directory = join(root, 'secrets')
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir
  vi.spyOn(fsPromises, 'mkdir').mockImplementation(async (path, options) => {
    if (path === directory) throw Object.assign(new Error('private exception marker'), { code: osCode })
    return original(path, options)
  })
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  await expect(
    service.save({
      providerId: 'deepseek',
      baseUrl: server.baseUrl,
      apiKey: 'sk-test-value',
      model: 'deepseek-flash',
      expectedRevision: 0,
    }),
  ).rejects.toMatchObject({ code })
  expect((await service.get()).revision).toBe(0)
  const audit = await readFile(join(root, 'data', 'audit', 'configuration.jsonl'), 'utf8')
  expect(JSON.parse(audit.trim())).toMatchObject({
    detail: { errorClass: 'CredentialStoreError', reason: 'io', osCode, path: directory },
  })
  expect(audit).not.toContain('private exception marker')
  expect(audit).not.toContain('sk-test-value')
})

it.each([
  ['openai', 'the cheapest priced model'],
  ['agnes-ai', 'the first light-tier model when the provider publishes no prices'],
] as const)('follows %s for an unset fast slot: %s', async (providerId, _rule) => {
  const entry = getApiKeyProvider(providerId)
  if (!entry) throw new Error(`${providerId} registry entry missing`)
  const records = (await entry.createAdapter()).models(entry.route)
  const price = (id: string) => {
    const cost = records.find((record) => record.id === id)?.cost
    return cost ? cost.input + cost.output : 0
  }
  // The default model is deliberately not the expected answer.
  const model = records.some((record) => price(record.id) > 0)
    ? [...records].sort((a, b) => price(b.id) - price(a.id))[0]?.id
    : records.find((record) => !record.id.includes('flash'))?.id
  if (!model) throw new Error(`${providerId} catalogue is empty`)
  const server = await fixture(records.map((record) => record.id))
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  expect(await service.modelSlots()).toEqual({ revision: 0, slots: {} })
  const saved = await service.save({
    providerId,
    baseUrl: server.baseUrl,
    apiKey: 'sk-test-value',
    model,
    expectedRevision: 0,
  })
  const account = saved.accounts?.[0]
  if (!account) throw new Error('account was not saved')
  const ids = account.models.map((row) => row.id)
  const priced = ids.filter((id) => price(id) > 0)
  const expected = priced.length
    ? priced.reduce((cheapest, id) => (price(id) < price(cheapest) ? id : cheapest))
    : ids.find((id) => id.includes('flash'))
  if (!expected) throw new Error('the catalogue offers no model to follow')
  expect(expected).not.toBe(model)
  const auto = { fast: { accountId: account.accountId, route: account.route, model: expected } }
  expect(await service.modelSlots()).toEqual({ revision: 1, slots: {}, auto })

  // The verifier is never automatic, and choosing it leaves the fast slot following the account.
  const verifier = { route: account.route, model }
  expect(await service.saveModelSlots({ revision: 1, slots: { verifier }, auto })).toEqual({
    revision: 2,
    slots: { verifier },
    auto,
  })
  // An explicit model and an explicit "none" are both the person's choice.
  expect(await service.saveModelSlots({ revision: 2, slots: { fast: verifier } })).toEqual({
    revision: 3,
    slots: { fast: verifier },
  })
  expect(await service.saveModelSlots({ revision: 3, slots: { fast: null } })).toEqual({
    revision: 4,
    slots: { fast: null },
  })
  // Without a usable default account there is nothing to follow.
  await service.saveModelSlots({ revision: 4, slots: {} })
  await service.account?.({ accountId: account.accountId, action: 'disable', expectedRevision: 5 })
  expect((await service.modelSlots()).auto).toBeUndefined()
})

it('persists explicit auxiliary defaults under the shared revision without changing provider selection', async () => {
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  expect(await service.modelSlots()).toEqual({ revision: 0, slots: {} })
  const slots = { fast: { route: 'local', model: 'reviewer' }, verifier: null }
  expect(await service.saveModelSlots({ revision: 0, slots })).toEqual({ revision: 1, slots })
  expect(await service.profileInput()).toEqual({})
  const reopened = createConfigurationService({ home: root, profile: 'local-dev' })
  expect(await reopened.modelSlots()).toEqual({ revision: 1, slots })
  await expect(reopened.saveModelSlots({ revision: 0, slots: {} })).rejects.toMatchObject({
    code: 'CONFIG_REVISION_CONFLICT',
  })
  await expect(
    reopened.saveModelSlots({
      revision: 1,
      slots: { primary: { route: 'local', model: 'reviewer' } },
    } as never),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  const saved = await reopened.saveSessionDefaults({ revision: 1, defaults: {} })
  expect((await reopened.modelSlots()).slots).toEqual(slots)
  expect(saved.revision).toBe(2)
  expect(await reopened.saveModelSlots({ revision: 2, slots: { fast: null, verifier: null } })).toEqual({
    revision: 3,
    slots: { fast: null, verifier: null },
  })
})

it.each(['missing', 'unreadable'] as const)(
  'excludes a %s default credential, falls back only to a configured account, and recovers on save',
  async (failure) => {
    const entry = getApiKeyProvider('openai')
    if (!entry) throw new Error('openai registry entry missing')
    const model = (await entry.createAdapter()).models(entry.route)[0]?.id
    if (!model) throw new Error('model missing')
    const server = await fixture(model)
    const root = await home()
    const service = createConfigurationService({ home: root, profile: 'local-dev' })
    const input = { providerId: 'openai', baseUrl: server.baseUrl, model }
    await service.save({ ...input, accountId: 'work', apiKey: 'test-work-key' })
    await service.save({ ...input, accountId: 'personal', apiKey: 'test-person-key' })
    const original = await service.profileInput()
    const [work, personal] = original.provider?.routes ?? []
    if (!work?.credentialRef || !personal?.credentialRef) throw new Error('account routes missing')
    const store = createCredentialStore({ root })
    if (failure === 'missing') await store.remove(work.credentialRef)
    else {
      // Malformed credential bytes are unreadable and must never enter an audit message.
      const name = work.credentialRef.split('/').at(-1)
      if (!name) throw new Error('credential name missing')
      await writeFile(join(root, 'secrets', 'openai', name), 'test-bad-key', { mode: 0o600 })
    }
    const reloaded = createConfigurationService({ home: root, profile: 'local-dev' })
    const degraded = await reloaded.profileInput()
    expect(degraded.provider?.routes?.map((row) => row.route)).toEqual([personal.route])
    const status = await reloaded.get()
    expect(status).toMatchObject({
      configured: true,
      defaultAccountId: 'personal',
      provider: { route: personal.route },
    })
    expect(status.accounts?.find((row) => row.accountId === 'work')).toMatchObject({
      enabled: true,
      credentialConfigured: false,
      credentialIssue: failure === 'missing' ? 'CONFIG_CREDENTIAL_REQUIRED' : 'CONFIG_CREDENTIAL_UNREADABLE',
    })
    // Availability never rewrites the saved preference or increments a revision.
    expect(JSON.parse(await readFile(await savedModelPath(root), 'utf8')).defaultAccountId).toBe('work')
    expect(status.revision).toBe(2)
    await store.remove(personal.credentialRef)
    expect((await reloaded.profileInput()).provider).toMatchObject({ routes: [], catalog: { include: [] } })
    expect(await reloaded.get()).toMatchObject({ configured: false, defaultAccountId: null, provider: null })
    const restored = await reloaded.save({
      ...input,
      accountId: 'work',
      apiKey: 'test-new-key',
      expectedRevision: 2,
    })
    expect(restored).toMatchObject({ configured: true, defaultAccountId: 'work', revision: 3 })
    expect((await reloaded.profileInput()).provider?.routes?.map((row) => row.route)).toEqual([work.route])
    const audit = await readFile(join(root, 'data', 'audit', 'configuration.jsonl'), 'utf8').catch(() => '')
    expect(audit + JSON.stringify([status, degraded, restored])).not.toMatch(/test-(work|person|new|bad)-key/)
  },
)
