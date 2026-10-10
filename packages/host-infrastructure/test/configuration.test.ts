import * as fsPromises from 'node:fs/promises'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getApiKeyProvider } from '@agnes/ai'
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
  model: string,
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
    response.end(JSON.stringify({ object: 'list', data: [{ id: model }] }))
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
  const selection = { loop: { id: 'workflow', version: '1.0.0' } }
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

it('tests Kimi Coding Plan through its Anthropic-compatible catalogue and fails closed on unknown models', async () => {
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
          api: 'anthropic-messages',
          baseUrl: 'https://api.kimi.com/coding',
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
  expect(requests[0]?.headers.get('x-api-key')).toBe('kimi-test-value')
  expect(requests[0]?.headers.get('anthropic-version')).toBe('2023-06-01')
  expect(requests[0]?.headers.get('authorization')).toBeNull()

  offeredModel = 'unreviewed-kimi-model'
  await expect(service.test({ providerId: 'kimi-coding', apiKey: 'kimi-test-value' })).resolves.toMatchObject(
    { models: expect.any(Array), verified: false },
  )
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
  await service.account({ accountId: 'work', action: 'remove', expectedRevision: 5 })
  const empty = await service.account({ accountId: 'personal', action: 'remove', expectedRevision: 6 })
  expect(empty).toMatchObject({ configured: false, accounts: [], defaultAccountId: null })
  expect(await reloaded.get()).toEqual(empty)
  // Existing sessions retain their immutable credential snapshot after configuration deletion.
  const ref = oldProfile.provider?.routes?.[0]?.credentialRef
  if (!ref) throw new Error('missing old ref')
  expect(await createCredentialStore({ root }).read(ref)).toMatchObject({ value: 'key-work' })
})

it('migrates v1 only on successful write, preserves its route and rejects competing revisions', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('catalogue')
  const model = (await entry.createAdapter()).models(entry.route)[0]
  if (!model) throw new Error('catalogue')
  const root = await home(),
    server = await fixture(model.id)
  const profile = 'local-dev',
    hash = createHash('sha256').update(profile).digest('hex').slice(0, 16)
  const ref = `secret://openai/profile-${hash}-r1`
  await createCredentialStore({ root }).putApiKey(ref, 'legacy-key')
  const dir = join(root, 'profiles', profile),
    file = join(dir, 'configuration.json')
  await mkdir(dir, { recursive: true })
  const original = JSON.stringify({
    version: 1,
    profile,
    revision: 1,
    provider: {
      id: 'openai',
      baseUrl: server.baseUrl,
      model: model.id,
      models: [{ id: model.id, name: model.name }],
      credentialRef: ref,
    },
  })
  await writeFile(file, original)
  const service = createConfigurationService({ home: root, profile })
  expect((await service.get()).accounts?.[0]).toMatchObject({ accountId: 'legacy-openai', route: 'openai' })
  expect(await readFile(file, 'utf8')).toBe(original)
  await expect(
    service.save({
      accountId: 'other',
      providerId: 'openai',
      baseUrl: server.baseUrl,
      model: 'unknown',
      apiKey: 'new-key',
    }),
  ).rejects.toMatchObject({ code: 'CONFIG_MODEL_UNAVAILABLE' })
  expect(await readFile(file, 'utf8')).toBe(original)
  const peer = createConfigurationService({ home: root, profile })
  const results = await Promise.allSettled([
    service.save({ accountId: 'legacy-openai', providerId: 'openai', model: model.id, expectedRevision: 1 }),
    peer.save({
      accountId: 'other',
      providerId: 'openai',
      baseUrl: server.baseUrl,
      model: model.id,
      apiKey: 'other-key',
      expectedRevision: 1,
    }),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const failed = results.find((r) => r.status === 'rejected')
  expect(failed?.status === 'rejected' ? failed.reason : undefined).toMatchObject({
    code: 'CONFIG_REVISION_CONFLICT',
  })
  expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2)
  expect((await peer.profileInput()).provider?.routes?.some((r) => r.route === 'openai')).toBe(true)
})

it('persists session defaults in existing configuration with cross-instance revision checks', async () => {
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  const defaults = {
    preset: 'read-only',
    loop: { id: 'workflow', version: '1.0.0' },
    modelAdapter: { id: 'adapter', version: '2.0.0', model: 'model' },
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
    reloaded.saveSessionDefaults({ revision: 1, defaults: { loop: { id: '', version: '1' } } }),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  await service.saveSessionDefaults({ revision: 1, defaults: {} })
  expect(await reloaded.sessionDefaults()).toEqual({ revision: 2, defaults: {} })
})

it('persists child engines beside session defaults and drops invalid fields', async () => {
  const { DISABLED_CHILD_ENGINES } = await import('@agnes/base/child-engines')
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
  await service.saveSessionDefaults({ revision: 2, defaults: { preset: 'read-only' } })
  expect((await service.childEngines()).engines.codex).toMatchObject({ enabled: true, allow: ['codex'] })
  await service.saveChildEngines({ revision: 3, engines })
  expect(await service.sessionDefaults()).toEqual({ revision: 4, defaults: { preset: 'read-only' } })
  const stored = JSON.parse(await readFile(file, 'utf8')) as { childEngines?: unknown }
  stored.childEngines = { broken: true }
  await writeFile(file, JSON.stringify(stored))
  const reloaded = createConfigurationService({ home: root, profile: 'local-dev' })
  expect(await reloaded.sessionDefaults()).toEqual({ revision: 4, defaults: { preset: 'read-only' } })
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
    await expect(service.get()).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_PERMISSIONS' })
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
