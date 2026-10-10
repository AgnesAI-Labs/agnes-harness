import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getApiKeyProvider } from '@agnes/ai'
import { captureModelPriceQuote } from '@agnes/core'
import * as systemNode from '@agnes/system-node'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { createCredentialStore } from '../src/adapters/credential-store.js'
import { createConfigurationService } from '../src/configuration.js'

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

it('round-trips a declared custom model without /models, preserves unknown price and rejects key forwarding to changed targets or protocols', async () => {
  const root = await home()
  // A legacy home may be public while its configuration profile is already private.
  if (process.platform !== 'win32') await chmod(root, 0o755)
  let rejectSystem = false
  let priceMetadata = false
  const inferenceRequests: Request[] = []
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = new Request(_url, init)
    expect(wire.redirect).toBe('error')
    if (wire.url.endsWith('/model/info')) {
      expect(wire.method).toBe('GET')
      expect(wire.headers.get('authorization')).toBe('Bearer custom-test')
      return priceMetadata
        ? Response.json({
            data: [
              {
                model_name: 'outside-vendor-directory',
                model_info: {
                  input_cost_per_token: 3e-7,
                  output_cost_per_token: 1.2e-6,
                  cache_read_input_token_cost: 6e-9,
                  cache_creation_input_token_cost: 0,
                },
              },
            ],
          })
        : Response.json({}, { status: 404 })
    }
    if (wire.url.endsWith('/models'))
      return Response.json({ data: [{ id: 'outside-vendor-directory' }, { id: 'another-manual-model' }] })
    inferenceRequests.push(wire.clone())
    const body = await wire.json()
    if (
      rejectSystem &&
      body.messages.some((message: { role: string }, index: number) => index > 0 && message.role === 'system')
    )
      return Response.json({ error: { message: 'custom-test private upstream detail' } }, { status: 400 })
    const chunk = {
      id: 'c',
      model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  const service = createConfigurationService({ home: root, profile: 'local-dev', request })
  const custom = {
    api: 'openai-completions' as const,
    contextWindow: 32768,
    maxTokens: 1024,
    input: ['text' as const],
    reasoning: false,
    toolCalls: true,
    maxTokensField: 'max_tokens' as const,
  }
  const input = {
    providerId: 'custom-openai',
    baseUrl: 'https://custom.example.invalid/v1',
    model: 'outside-vendor-directory',
    custom,
    apiKey: 'custom-test',
  }
  expect((await service.providers()).providers).toContainEqual(
    expect.objectContaining({ id: 'custom-openai' }),
  )
  expect(await service.test(input)).toMatchObject({ verified: true, models: [{ id: input.model }], custom })
  expect(inferenceRequests[0]?.url).toBe(`${input.baseUrl}/chat/completions`)
  expect(await inferenceRequests[0]?.json()).toMatchObject({
    model: input.model,
    stream: true,
    max_tokens: 64,
  })
  const saved = await service.save({ ...input, expectedRevision: 0 })
  if (process.platform !== 'win32') expect((await stat(root)).mode & 0o7777).toBe(0o700)
  expect(saved.accounts?.[0]?.custom).toEqual(custom)
  expect(JSON.stringify(saved)).not.toContain(input.apiKey)
  const fresh = createConfigurationService({ home: root, profile: 'local-dev', request })
  expect(await fresh.get()).toEqual(saved)
  const record = (await fresh.profileInput()).provider?.routes?.[0]?.models?.[0]
  expect(record).toMatchObject({
    id: input.model,
    api: custom.api,
    contextWindow: 32768,
    maxTokens: 1024,
    toolCallFormats: ['native'],
    pricePolicy: { perMillion: { inputUncached: null, output: null } },
  })
  await expect(fresh.test({ providerId: input.providerId, model: input.model })).resolves.toMatchObject({
    verified: true,
  })
  const count = request.mock.calls.length
  for (const update of [
    { baseUrl: 'https://changed.example.invalid/v1' },
    { custom: { ...custom, api: 'openai-responses' as const } },
  ]) {
    await expect(
      fresh.test({ providerId: input.providerId, model: input.model, ...update }),
    ).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REQUIRED' })
  }
  expect(request.mock.calls.length).toBe(count)
  priceMetadata = true
  await expect(
    fresh.save({ providerId: input.providerId, model: input.model, expectedRevision: 1 }),
  ).resolves.toMatchObject({ revision: 2 })
  const priced = createConfigurationService({ home: root, profile: 'local-dev', request })
  expect((await priced.profileInput()).provider?.routes?.[0]?.models?.[0]?.pricePolicy).toMatchObject({
    currency: 'USD',
    perMillion: { inputUncached: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    source: { url: `${input.baseUrl}/model/info` },
  })
  const directory = await fresh.test({ providerId: input.providerId, catalogueOnly: true })
  expect(directory).toEqual({
    verified: false,
    models: [
      { id: input.model, name: input.model },
      { id: 'another-manual-model', name: 'another-manual-model' },
    ],
  })
  expect(String(request.mock.calls.at(-1)?.[0])).toBe(`${input.baseUrl}/models`)
  expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
    method: 'GET',
    headers: { Authorization: 'Bearer custom-test' },
  })
  await expect(
    fresh.test({
      providerId: input.providerId,
      catalogueOnly: true,
      baseUrl: 'https://changed.example.invalid/v1',
    }),
  ).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REQUIRED' })
  await fresh.save({
    providerId: input.providerId,
    model: input.model,
    custom: { ...custom, modelIds: directory.models.map((model) => model.id) },
    expectedRevision: 2,
  })
  expect((await fresh.get()).accounts?.[0]?.models.map((model) => model.id)).toEqual([
    input.model,
    'another-manual-model',
  ])
  expect((await fresh.profileInput()).provider?.routes?.[0]?.models?.map((model) => model.id)).toEqual([
    input.model,
    'another-manual-model',
  ])
  const priceRecords = (await priced.profileInput()).provider?.routes?.[0]?.models
  expect(
    priceRecords?.find((record) => record.id === input.model)?.pricePolicy?.perMillion.inputUncached,
  ).toBe(0.3)
  expect(
    priceRecords?.find((record) => record.id === 'another-manual-model')?.pricePolicy?.perMillion
      .inputUncached,
  ).toBeNull()
  const pricedRecord = priceRecords?.find((record) => record.id === input.model)
  if (!pricedRecord?.route || !pricedRecord.pricePolicy) throw new Error('Missing priced model')
  const quote = captureModelPriceQuote(
    { models: () => priceRecords ?? [], async *infer() {} },
    { route: pricedRecord.route, model: pricedRecord.id },
    1,
  )
  expect(quote).toMatchObject({
    basis: 'configured',
    policy: { perMillion: { inputUncached: 0.3, output: 1.2 } },
  })
  pricedRecord.pricePolicy.perMillion.inputUncached = 9
  expect(quote?.policy.perMillion.inputUncached).toBe(0.3)
  const declaration = { ...custom, supportsMidConvoSystemMessages: true }
  expect(
    await fresh.test({ providerId: input.providerId, model: input.model, custom: declaration }),
  ).toMatchObject({
    verified: true,
    customVerification: {
      baseUrl: input.baseUrl,
      model: input.model,
      ordering: 'unverified',
      checks: [
        { id: 'inference', status: 'passed' },
        { id: 'mid-conversation-system', status: 'passed' },
      ],
    },
  })
  // Saving never trusts an earlier successful browser test or persists a failed declaration.
  rejectSystem = true
  const rejected = await fresh.test({ providerId: input.providerId, model: input.model, custom: declaration })
  expect(rejected).toMatchObject({
    verified: false,
    customVerification: {
      checks: [
        { id: 'inference', status: 'passed' },
        { id: 'mid-conversation-system', status: 'failed', reason: 'endpoint' },
      ],
    },
  })
  expect(JSON.stringify(rejected)).not.toContain('custom-test')
  await expect(
    fresh.save({
      providerId: input.providerId,
      model: input.model,
      custom: declaration,
      expectedRevision: 3,
    }),
  ).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
  expect((await fresh.get()).revision).toBe(3)
  expect((await fresh.get()).accounts?.[0]?.custom?.supportsMidConvoSystemMessages).not.toBe(true)
  priceMetadata = false
  await fresh.save({ providerId: input.providerId, model: input.model, expectedRevision: 3 })
  expect(
    (await fresh.profileInput()).provider?.routes?.[0]?.models?.[0]?.pricePolicy?.perMillion.inputUncached,
  ).toBeNull()
  expect(quote?.policy.perMillion.inputUncached).toBe(0.3)
  const storedBeforeRefresh = JSON.parse(
    await readFile(join(root, 'profiles/local-dev/configuration.json'), 'utf8'),
  )
  const inferenceCount = inferenceRequests.length
  priceMetadata = true
  const refreshAccountId = (await fresh.get()).accounts?.[0]?.accountId
  if (!refreshAccountId) throw new Error('Missing refresh account')
  const refreshed = await fresh.account({
    accountId: refreshAccountId,
    action: 'refresh-prices',
    expectedRevision: 4,
  })
  expect(refreshed.revision).toBe(5)
  expect(inferenceRequests.length).toBe(inferenceCount)
  const storedAfterRefresh = JSON.parse(
    await readFile(join(root, 'profiles/local-dev/configuration.json'), 'utf8'),
  )
  const withoutPrices = (account: { modelPricePolicies?: unknown }) => {
    const { modelPricePolicies: _prices, ...rest } = account
    return rest
  }
  expect(storedAfterRefresh.accounts.map(withoutPrices)).toEqual(
    storedBeforeRefresh.accounts.map(withoutPrices),
  )
  expect(storedAfterRefresh.defaultAccountId).toBe(storedBeforeRefresh.defaultAccountId)
  expect(
    (await fresh.profileInput()).provider?.routes?.[0]?.models?.[0]?.pricePolicy?.perMillion.inputUncached,
  ).toBe(0.3)
  await expect(
    fresh.account({ accountId: refreshAccountId, action: 'refresh-prices', expectedRevision: 4 }),
  ).rejects.toMatchObject({ code: 'CONFIG_REVISION_CONFLICT' })
  for (const declaration of [
    { ...custom, maxTokens: custom.contextWindow + 1 },
    { ...custom, contextWindow: 1.5 },
    { ...custom, input: ['image'] },
  ]) {
    await expect(fresh.test({ ...input, custom: declaration as never })).rejects.toMatchObject({
      code: 'CONFIG_INVALID_INPUT',
    })
  }
})

it('tests a real provider catalogue, saves an atomic non-secret record, and exposes the Host overlay', async () => {
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('openai registry entry missing')
  const adapter = await entry.createAdapter()
  const model = adapter.models(entry.route)[0]?.id
  if (!model) throw new Error('openai catalogue is empty')
  const server = await fixture(model)
  const root = await home()
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
  })
  expect(saved).toMatchObject({ profile: 'local-dev', revision: 1, configured: true, effect: 'new-sessions' })
  expect(await service.get()).toEqual(saved)
  expect(saved.accounts?.[0]?.models[0]?.defaultSettings).toEqual(defaultSettings)

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
  const second = await service.save({ providerId: 'openai', model, expectedRevision: 1 })
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

it('keeps the prior revision after a failed probe and rejects non-compatible endpoint overrides', async () => {
  const entry = getApiKeyProvider('openai')
  if (!entry) throw new Error('openai registry entry missing')
  const model = (await entry.createAdapter()).models(entry.route)[0]?.id
  if (!model) throw new Error('openai catalogue is empty')
  const server = await fixture(model, 401)
  const root = await home()
  const service = createConfigurationService({ home: root, profile: 'local-dev' })
  await expect(
    service.save({ providerId: 'openai', baseUrl: server.baseUrl, apiKey: 'sk-test-value', model }),
  ).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
  await expect(service.get()).resolves.toMatchObject({ revision: 0, configured: false, provider: null })
  await expect(
    service.test({ providerId: 'anthropic', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test-value' }),
  ).rejects.toMatchObject({ code: 'CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED' })
})

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
