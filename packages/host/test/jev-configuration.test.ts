import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JevSettings } from '@agnes/protocol'
import * as systemNode from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { createCredentialStore } from '../src/adapters/credential-store.js'
import {
  createJevConfigurationService,
  decodeJevConfigurationCapture,
  jevFromCapture,
} from '../src/jev-configuration.js'
import { jevFromEnvironment } from '../src/runtime/catalog.js'

const homes: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'agnes-jev-config-'))
  homes.push(home)
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({
      model: 'jev-test',
      answers: { is_test: { type: 'noul', noul: 0.99 } },
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
  )
  const service = createJevConfigurationService({ home, profile: 'local-dev', env: {}, request })
  return { home, request, service }
}
const settings: JevSettings = {
  transport: 'native',
  endpoint: 'https://jev.example.invalid/decision',
  model: 'jev',
  authentication: 'bearer',
  enabled: true,
}

it('stores private revisioned references, never returns a key, and freezes old workers across saves until restart', async () => {
  const { home, request, service } = await fixture()
  expect(await service.get()).toMatchObject({ revision: 0, configured: false, source: 'none' })
  expect(await service.test({ settings, apiKey: 'jev-test' })).toMatchObject({
    verified: true,
    model: 'jev-test',
  })
  expect((await service.get()).revision).toBe(0)
  const first = await service.save({ settings, apiKey: 'jev-test', expectedRevision: 0 })
  expect(first).toMatchObject({
    revision: 1,
    configured: true,
    credentialConfigured: true,
    effect: 'restart-required',
    settings: { backend: 'jev' },
  })
  expect(JSON.stringify(first)).not.toContain('jev-test')
  const capture = await service.capture()
  expect(decodeJevConfigurationCapture(capture, 'local-dev')).toEqual(capture)
  expect(() => decodeJevConfigurationCapture(capture, 'another-profile')).toThrow()
  const runtime = await jevFromCapture(capture, home, request)
  await service.save({ settings, apiKey: 'replacement-key', expectedRevision: 1 })
  expect(runtime && 'decision' in runtime).toBe(true)
  if (!runtime || !('decision' in runtime)) throw new Error('runtime missing')
  await runtime.decision.transport.invoke(
    { model: settings.model, state: 'test', questions: {} },
    new AbortController().signal,
  )
  expect(request.mock.calls.at(-1)?.[1]?.headers).toMatchObject({ authorization: 'Bearer jev-test' })
  expect(await service.get()).toMatchObject({ revision: 2, effect: 'restart-required' })
  const restarted = createJevConfigurationService({ home, profile: 'local-dev', env: {} })
  expect(await restarted.get()).toMatchObject({ revision: 2, effect: 'new-sessions' })
  const next = await service.capture()
  expect(next.credentialRef).not.toBe(capture.credentialRef)
  const store = createCredentialStore({ root: home })
  expect(await store.read(capture.credentialRef ?? '')).toMatchObject({ value: 'jev-test' })
  const path = join(home, 'profiles', 'local-dev', 'jev-configuration.json')
  expect(await readFile(path, 'utf8')).not.toContain('replacement-key')
  const legacy = JSON.parse(await readFile(path, 'utf8'))
  delete legacy.settings.backend
  await writeFile(path, JSON.stringify(legacy))
  expect(await restarted.get()).toMatchObject({ settings: { backend: 'jev' } })
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(home, 'profiles', 'local-dev'))).mode & 0o777).toBe(0o700)
  }
})

it('rejects conflicts and changed destinations without sending or replacing the old credential; failed publication keeps the prior revision', async () => {
  const { home, request, service } = await fixture()
  await service.save({ settings, apiKey: 'jev-test', expectedRevision: 0 })
  const capture = await service.capture()
  await expect(service.save({ settings, expectedRevision: 0 })).rejects.toMatchObject({
    code: 'CONFIG_REVISION_CONFLICT',
  })
  await expect(
    service.test({ settings: { ...settings, endpoint: 'https://changed.example.invalid/decision' } }),
  ).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REQUIRED' })
  await expect(service.test({ settings: { ...settings, backend: 'laya' } })).rejects.toMatchObject({
    code: 'CONFIG_CREDENTIAL_REQUIRED',
  })
  expect(request).not.toHaveBeenCalled()
  vi.spyOn(systemNode, 'renameWriteThrough').mockImplementationOnce(async () => {
    throw new Error('synthetic failure')
  })
  await expect(
    service.save({ settings, apiKey: 'replacement-key', expectedRevision: 1 }),
  ).rejects.toMatchObject({ code: 'CONFIG_PERSIST_FAILED' })
  expect(await service.capture()).toEqual(capture)
  expect(await createCredentialStore({ root: home }).read(capture.credentialRef ?? '')).toMatchObject({
    value: 'jev-test',
  })
})

it('validates Cloudflare fixed targets and strict scored responses without exposing upstream errors', async () => {
  const { service, request } = await fixture()
  const cloudflare: JevSettings = {
    ...settings,
    transport: 'cloudflare',
    accountId: 'a'.repeat(32),
    endpoint: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run`,
    model: 'typesafe/jev',
  }
  request.mockResolvedValueOnce(
    Response.json({
      success: true,
      errors: [],
      result: {
        state: 'Completed',
        result: { model: 'jev-test', answers: { is_test: { type: 'noul', noul: 0.98 } } },
      },
    }),
  )
  expect(await service.test({ settings: cloudflare, apiKey: 'jev-test' })).toMatchObject({
    verified: true,
  })
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
    model: 'typesafe/jev',
    input: { questions: { is_test: { type: 'noul' } } },
  })
  await expect(
    service.test({ settings: { ...cloudflare, backend: 'laya' }, apiKey: 'jev-test' }),
  ).rejects.toMatchObject({ code: 'CONFIG_JEV_TRANSPORT_MISMATCH' })
  for (const wrong of [
    { ...cloudflare, authentication: 'none' },
    { ...cloudflare, endpoint: settings.endpoint },
    { ...settings, endpoint: 'https://user:password@example.invalid/' },
    { ...settings, decisionRequestCredits: 0 },
  ])
    await expect(service.test({ settings: wrong as JevSettings, apiKey: 'jev-test' })).rejects.toMatchObject({
      code: 'CONFIG_INVALID_INPUT',
    })
  for (const score of [null, 2, -0.1, '0.5']) {
    request.mockResolvedValueOnce(Response.json({ answers: { is_test: { type: 'noul', noul: score } } }))
    await expect(service.test({ settings, apiKey: 'jev-test' })).rejects.toMatchObject({
      code: 'CONFIG_TEST_FAILED',
      message: 'Jev configuration failed.',
    })
  }
})

it('refuses a Cloudflare endpoint declared as native instead of sending the wrong wire shape', async () => {
  const { service, request } = await fixture()
  const mismatch: JevSettings = {
    ...settings,
    model: 'typesafe/jev',
    endpoint: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run`,
  }
  await expect(service.test({ settings: mismatch, apiKey: 'jev-test' })).rejects.toMatchObject({
    code: 'CONFIG_JEV_TRANSPORT_MISMATCH',
  })
  await expect(
    service.save({ settings: mismatch, apiKey: 'jev-test', expectedRevision: 0 }),
  ).rejects.toMatchObject({ code: 'CONFIG_JEV_TRANSPORT_MISMATCH' })
  expect(request).not.toHaveBeenCalled()
  expect((await service.get()).revision).toBe(0)
})

it('reports a rejected credential as an authorization failure instead of a transport fault', async () => {
  const { service, request } = await fixture()
  request.mockResolvedValueOnce(new Response('denied', { status: 401 }))
  await expect(service.test({ settings, apiKey: 'jev-test' })).rejects.toMatchObject({
    code: 'CONFIG_TEST_UNAUTHORIZED',
    message: 'Jev configuration failed.',
  })
  request.mockResolvedValueOnce(new Response('denied', { status: 403 }))
  await expect(service.test({ settings, apiKey: 'jev-test' })).rejects.toMatchObject({
    code: 'CONFIG_TEST_UNAUTHORIZED',
  })
  request.mockResolvedValueOnce(new Response('boom', { status: 500 }))
  await expect(service.test({ settings, apiKey: 'jev-test' })).rejects.toMatchObject({
    code: 'CONFIG_TEST_FAILED',
  })
})

it('refuses a pasted Bearer prefix rather than sending it as part of the token', async () => {
  const { service, request } = await fixture()
  for (const apiKey of ['Bearer jev-test', 'bearer   jev-test']) {
    await expect(service.test({ settings, apiKey })).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
    await expect(service.save({ settings, apiKey, expectedRevision: 0 })).rejects.toMatchObject({
      code: 'CONFIG_INVALID_INPUT',
    })
  }
  expect(request).not.toHaveBeenCalled()
  expect((await service.get()).revision).toBe(0)
})

it.each(['none', 'bearer'] as const)(
  'persists and restores the Laya backend with %s authentication',
  async (authentication) => {
    const { home, request, service } = await fixture()
    const laya: JevSettings = {
      ...settings,
      backend: 'laya',
      endpoint: 'http://127.0.0.1:8791/v1/systemone',
      model: 'multilingual',
      authentication,
    }
    const apiKey = authentication === 'bearer' ? 'laya-test' : undefined
    await service.test({ settings: laya, ...(apiKey ? { apiKey } : {}) })
    await service.save({ settings: laya, expectedRevision: 0, ...(apiKey ? { apiKey } : {}) })
    const restarted = createJevConfigurationService({ home, profile: 'local-dev', env: {} })
    expect(await restarted.get()).toMatchObject({ settings: laya, effect: 'new-sessions' })
    const captured = decodeJevConfigurationCapture(await restarted.capture(), 'local-dev')
    const runtime = await jevFromCapture(captured, home, request)
    if (!runtime || !('decision' in runtime)) throw new Error('Missing Laya runtime')
    expect(runtime.decision).toMatchObject({
      backend: 'laya',
      endpoint: laya.endpoint,
      model: 'multilingual',
    })
    await runtime.decision.transport.invoke(
      { model: laya.model, state: 'test', questions: {} },
      new AbortController().signal,
    )
    const [endpoint, init] = request.mock.calls.at(-1) ?? []
    expect(endpoint).toBe(laya.endpoint)
    expect(new Headers(init?.headers).get('authorization')).toBe(apiKey ? `Bearer ${apiKey}` : null)
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'multilingual', state: 'test', questions: {} })
  },
)

it('preserves both decision targets across saves and assembles a per-turn pool with an environment override', async () => {
  const { home, request, service } = await fixture()
  await service.save({ settings, apiKey: 'jev-test', expectedRevision: 0 })
  const laya: JevSettings = {
    ...settings,
    backend: 'laya',
    endpoint: 'http://127.0.0.1:8791/v1/systemone',
    model: 'multilingual',
    authentication: 'none',
  }
  const second = await service.save({ settings: laya, expectedRevision: 1 })
  expect(second.backends).toEqual([
    {
      backend: 'jev',
      settings: { ...settings, backend: 'jev' },
      configured: true,
      credentialConfigured: true,
    },
    { backend: 'laya', settings: laya, configured: true, credentialConfigured: true },
  ])
  const restarted = createJevConfigurationService({ home, profile: 'local-dev', env: {} })
  const capture = await restarted.capture()
  expect(capture.version).toBe(2)
  const runtime = await jevFromCapture(capture, home, request)
  if (!runtime || !('decision' in runtime)) throw new Error('Missing dual-target runtime')
  const jevTarget = runtime.backends?.jev
  const layaTarget = runtime.backends?.laya
  if (!jevTarget || !layaTarget) throw new Error('Missing pool targets')
  expect(runtime.defaultDecisionBackend).toBe('laya')
  await jevTarget.decision.transport.invoke(
    { model: 'jev-latest', state: 's', questions: {} },
    new AbortController().signal,
  )
  await layaTarget.decision.transport.invoke(
    { model: 'multilingual', state: 's', questions: {} },
    new AbortController().signal,
  )
  expect(
    request.mock.calls.map((entry) => [entry[0], new Headers(entry[1]?.headers).get('authorization')]),
  ).toEqual([
    ['https://jev.example.invalid/decision', 'Bearer jev-test'],
    ['http://127.0.0.1:8791/v1/systemone', null],
  ])
  const envLaya = jevFromEnvironment(
    {
      AGNES_JEV_BACKEND: 'laya',
      AGNES_JEV_ENDPOINT: 'http://127.0.0.1:9999/v1/systemone',
      AGNES_JEV_MODEL: 'multilingual',
      AGNES_JEV_AUTHENTICATION: 'none',
    },
    request,
  )
  const merged = await jevFromCapture(capture, home, request, envLaya)
  if (!merged || !('decision' in merged)) throw new Error('Missing merged runtime')
  const mergedJev = merged.backends?.jev
  if (!mergedJev) throw new Error('Environment target dropped its saved peer')
  expect(merged.defaultDecisionBackend).toBe('laya')
  expect(merged.decision.endpoint).toBe('http://127.0.0.1:9999/v1/systemone')
  expect(mergedJev.decision.endpoint).toBe('https://jev.example.invalid/decision')
})

it('keeps environment overrides explicit and rejects invalid or public persisted state', async () => {
  const { home, service } = await fixture()
  await service.save({ settings: { ...settings, authentication: 'none' }, expectedRevision: 0 })
  const override = createJevConfigurationService({
    home,
    profile: 'local-dev',
    env: { AGNES_JEV_MODEL: 'partial' },
  })
  expect(await override.get()).toMatchObject({ source: 'environment' })
  const path = join(home, 'profiles', 'local-dev', 'jev-configuration.json')
  if (process.platform !== 'win32') {
    await chmod(path, 0o644)
    await expect(service.get()).rejects.toMatchObject({ code: 'CONFIG_INVALID_STATE' })
    await chmod(path, 0o600)
  }
  await writeFile(path, JSON.stringify({ version: 1, revision: 1, settings, credentialRef: null }))
  await expect(service.get()).rejects.toMatchObject({ code: 'CONFIG_INVALID_STATE' })
})
