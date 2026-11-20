import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_ID, CODEX_PROVIDER } from '@agnes/ai'
import { fakeModel } from '@agnes/ai/testkit'
import { Context } from '@agnes/cordis'
import { type ModelAdapter, modelAdapterKind } from '@agnes/extension-api'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { codexCredentials } from '@agnes/host-infrastructure/adapters/codex-credentials'
import { afterEach, expect, it } from 'vitest'
import { installModelAdapters } from '../../src/assemble/model-adapters.js'
import { buildProvider } from '../../src/assemble/provider.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
const oauthRef = 'secret://openai-codex/account-test-r1'

it('names every route left without a usable credential, and none that works without a bound key', async () => {
  const home = join(await mkdtemp(join(tmpdir(), 'agnes-provider-credentials-')), 'home')
  roots.push(join(home, '..'))
  // An OAuth login that resolved: the route authenticates per request, not through a bound key.
  await codexCredentials(home, oauthRef).modify(CODEX_ID, async () => ({
    type: 'oauth',
    access: `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-a' } })).toString('base64url')}.signature`,
    refresh: 'synthetic-refresh',
    expires: Date.now() + 3_600_000,
    accountId: 'account-a',
  }))
  const codex = (await CODEX_PROVIDER.createAdapter()).models(CODEX_ID)[0]
  if (!codex) throw new Error('fixture codex model missing')
  const baseUrl = 'http://127.0.0.1:1/v1'
  const keyed = fakeModel({ id: 'keyed-1', route: 'account-keyed', api: 'openai-completions', baseUrl })
  const keyless = fakeModel({ id: 'local-1', route: 'local', api: 'openai-completions', baseUrl })
  const reused = fakeModel({ id: 'reused-1', route: 'my-gateway', api: 'openai-completions', baseUrl })
  const profile = {
    dataDir: join(home, 'data'),
    provider: {
      package: '@agnes/ai',
      adapters: ['@agnes/ai'],
      routes: [
        {
          route: keyed.route,
          api: keyed.api,
          baseUrl,
          credentialRef: 'secret://generic/00000000-0000-4000-8000-000000000000',
          models: [keyed],
        },
        { route: keyless.route, api: keyless.api, baseUrl, keyless: true, models: [keyless] },
        {
          // A profile route that reuses a built-in reference is optional too, and is left unbound.
          route: reused.route,
          api: reused.api,
          baseUrl,
          credentialRef: 'secret://anthropic/default',
          models: [reused],
        },
        {
          route: 'account-work',
          api: codex.api,
          baseUrl: codex.baseUrl,
          credentialRef: oauthRef,
          models: [{ ...codex, route: 'account-work' }],
        },
      ],
    },
    limits: {},
    adapters: { secrets: { kind: 'file', path: join(home, 'secrets') } },
  } as unknown as ResolvedProfile
  const secrets: Record<string, string> = {
    'secret://generic/00000000-0000-4000-8000-000000000000': 'synthetic-account-key',
    'secret://deepseek/default': 'synthetic-deepseek-key',
    // Present but unable to authenticate anything: the same outcome as absent.
    'secret://openai/default': '  ',
  }
  const built = await buildProvider(
    profile,
    { primary: { route: keyed.route, model: keyed.id } },
    {
      secrets: (ref) => {
        const value = secrets[ref]
        if (value === undefined) throw new Error('not configured')
        return value
      },
      clock: Date.now,
      log,
    },
  )
  try {
    const published = new Set(built.provider.models().map((model) => model.route))
    for (const route of ['anthropic', 'openai', 'deepseek', 'account-keyed', 'local', 'account-work'])
      expect(published).toContain(route)
    expect(built.uncredentialedRoutes).toContain('anthropic')
    expect(built.uncredentialedRoutes).toContain('openai')
    for (const route of ['deepseek', 'account-keyed', 'local', 'account-work'])
      expect(built.uncredentialedRoutes).not.toContain(route)
    expect(built.uncredentialedRoutes).toContain('my-gateway')
  } finally {
    await built.dispose()
  }
})

it('fits installed plugin routes without changing local routes, rejects collisions and permits explicit cloud inference', async () => {
  const root = new Context()
  const registry = installModelAdapters(root)
  const local = fakeModel({ id: 'local-only', route: 'local', api: 'local-wire' })
  const remote = fakeModel({ id: 'cloud-only', route: 'cloud-primary', api: 'cloud-wire' })
  const adapter = (id: string, wireApi: string): ModelAdapter => ({
    id,
    wireApi,
    version: '1.0.0',
    capabilities: { imageInput: false, tools: true, streaming: true },
    create: ({ routes }) => ({
      id,
      routes: () => [...routes],
      models: (route) => routes.find((item) => item.route === route)?.models ?? [],
      async *stream(_route, request) {
        yield { type: 'text_delta', delta: request.model }
        yield { type: 'done', reason: 'stop' }
      },
    }),
  })
  root.providers.registerHost(modelAdapterKind, 'local-package', adapter('local-wire', 'local-wire'))
  let offered = [
    {
      route: 'cloud-primary',
      api: 'cloud-adapter',
      baseUrl: 'https://cloud.fixture/v1',
      models: [remote],
      keyless: true,
    },
  ]
  const release = root.providers.registerHost(modelAdapterKind, 'cloud-package', {
    ...adapter('cloud-adapter', 'cloud-wire'),
    contributeRoutes: async () => offered,
  })
  const profile = {
    dataDir: '/synthetic/data',
    provider: {
      package: '@agnes/ai',
      adapters: ['local-wire'],
      catalog: { include: [] },
      routes: [
        {
          route: 'local',
          api: 'local-wire',
          baseUrl: 'https://local.fixture/v1',
          keyless: true,
          models: [local],
        },
      ],
    },
    limits: {},
    adapters: { secrets: { kind: 'env' } },
  } as unknown as ResolvedProfile
  const before = structuredClone(profile)
  const deps = {
    secrets: () => {
      throw Error('no credential store needed')
    },
    clock: Date.now,
    log,
    modelAdapters: registry,
  }
  const built = await buildProvider(profile, { primary: { route: 'local', model: 'local-only' } }, deps)
  try {
    expect(
      built.provider
        .models()
        .map((model) => model.id)
        .sort(),
    ).toEqual(['cloud-only', 'local-only'])
    expect(built.preconfiguredRoutes).toEqual(['cloud-primary'])
    expect(profile).toEqual(before)
    for (const model of [local, remote]) {
      const events = []
      for await (const event of built.provider.infer(
        {
          kind: 'inference',
          sessionKey: 'fixture',
          slot: 'primary',
          route: model.route,
          model: model.id,
          contractId: null,
          derivedHash: 'a'.repeat(64),
          system: 'fixture',
          tools: [],
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        },
        { signal: new AbortController().signal, toolNames: [] },
      ))
        events.push(event)
      expect(events).toContainEqual({ type: 'text_delta', delta: model.id })
    }
    offered = [{ ...offered[0]!, route: 'invalid.route' }]
    await expect(buildProvider(profile, undefined, deps)).rejects.toThrow('invalid contributed')
    offered = [{ ...offered[0]!, route: 'local' }]
    await expect(buildProvider(profile, undefined, deps)).rejects.toThrow('conflicts')
    offered = [{ ...offered[0]!, api: 'local-wire' }]
    await expect(buildProvider(profile, undefined, deps)).rejects.toThrow('invalid contributed')
  } finally {
    await built.dispose()
    await release()
    await root.fiber.dispose()
  }
})
