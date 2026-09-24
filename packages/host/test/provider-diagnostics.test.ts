import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_KEY_PROVIDER_REGISTRY, createProvider, runDoctor } from '@agnes/ai'
import { FakeAdapter, fakeModel } from '@agnes/ai/testkit'
import { expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

it('keeps managed account routes revoked across hot updates and cold Host rebuilds', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-host-removed-route-'))
  let { host } = await createTestHost({ dataDir })
  try {
    const initial = structuredClone(host.profile)
    initial.provider.catalog = { include: [] }
    await host.applyModelProfile(initial)
    const next = structuredClone(initial)
    next.provider.routes = [
      ...(next.provider.routes ?? []),
      {
        route: 'deepseek',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:1/v1',
        models: [fakeModel({ route: 'deepseek', id: 'account-model' })],
      },
    ]
    await host.applyModelProfile(next)
    expect(host.provider.models().some((model) => model.id === 'account-model')).toBe(true)
    await host.applyModelProfile(initial)
    expect(host.provider.models().some((model) => model.route === 'deepseek')).toBe(false)
    await host.applyModelProfile(initial)
    expect(host.provider.models().some((model) => model.route === 'deepseek')).toBe(false)
    await host.close()
    ;({ host } = await createTestHost({
      dataDir,
      profileInputs: { user: { name: initial.name, provider: initial.provider } },
    }))
    expect(host.provider.models().some((model) => model.route === 'deepseek')).toBe(false)
    expect(() =>
      host.validateModelSwitch({ slot: 'primary', route: 'deepseek', model: 'deepseek-chat' }),
    ).toThrow()
    await host.applyModelProfile(next)
    expect(host.provider.models().some((model) => model.id === 'account-model')).toBe(true)
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('preserves the assembled registry for typed diagnostics without rebuilding it', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-host-doctor-'))
  const adapter = new FakeAdapter({
    id: 'doctor-adapter',
    routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1' }],
    models: { gw: [fakeModel({ id: 'm1', route: 'gw', reasoning: false })] },
  })
  adapter.probe = async () => ({
    route: 'gw',
    ok: true,
    latencyMs: 0,
    checks: [
      {
        name: 'minimal_inference',
        ok: true,
        detail: JSON.stringify({
          modelId: 'm1',
          thinking: false,
          nativeToolCalls: true,
          usageComplete: true,
        }),
      },
    ],
  })
  let provider: ReturnType<typeof createProvider> | undefined
  const { host } = await createTestHost({
    dataDir,
    provider: (_profile, options) => {
      provider = createProvider({
        ...options,
        contract: options.contractStore,
        adapters: [adapter],
        routes: { primary: { route: 'gw', model: 'm1' } },
        clock: Date.now,
        secrets: () => '',
      })
      return provider
    },
  })
  try {
    const registry = host.provider.registry
    expect(registry).toBe(provider?.registry)
    if (!registry) throw new Error('expected assembled registry')
    expect(registry.fingerprint()).toBe(host.providerFingerprint)
    const result = await runDoctor(registry, { signal: new AbortController().signal })
    expect(result.ok).toBe(true)
    expect(result.models).toEqual([{ route: 'gw', id: 'm1', observed: true, mismatches: [] }])
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
it('does not invent a registry for an ordinary replacement provider', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-host-no-registry-'))
  const { host } = await createTestHost({ dataDir, script: [] })
  try {
    expect(host.provider.registry).toBeUndefined()
    expect(host.providerFingerprint).toBeNull()
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('pre-registers API-key providers without replacing the production route or certifying its unbound credential', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-host-production-registry-'))
  const { host } = await createTestHost({ dataDir })
  try {
    const registry = host.provider.registry
    if (!registry) throw new Error('production provider did not expose registry')
    expect(registry.models().some((model) => model.route === 'gw' && model.id === 'm1')).toBe(true)
    for (const entry of API_KEY_PROVIDER_REGISTRY)
      expect(registry.routes().some((route) => route.route === entry.route)).toBe(true)
    const result = await runDoctor(registry, { signal: new AbortController().signal })
    expect(result.ok).toBe(false)
    expect(result.models[0]?.observed).toBe(false)
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

it('leaves a profile-owned route in place when it shares a built-in API-key route name', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-host-provider-route-precedence-'))
  const model = fakeModel({
    id: 'deployment-deepseek',
    route: 'deepseek',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/v1',
  })
  const { host } = await createTestHost({
    dataDir,
    profileInputs: {
      user: {
        name: 'profile-owned-deepseek',
        provider: {
          package: '@agnes/ai',
          adapters: ['@agnes/ai'],
          routes: [
            {
              route: 'deepseek',
              api: 'openai-completions',
              baseUrl: 'http://127.0.0.1:1/v1',
              models: [model],
            },
          ],
        },
      },
    },
  })
  try {
    const registry = host.provider.registry
    if (!registry) throw new Error('production provider did not expose registry')
    expect(
      registry
        .models()
        .filter((candidate) => candidate.route === 'deepseek')
        .map((candidate) => candidate.id),
    ).toEqual(['deployment-deepseek'])
    // The other eleven bundled options remain independently selectable (Kimi Coding Plan raised
    // this from nine to ten, and the Agnes AI gateway route from ten to eleven -- see the
    // "feat(ai): add Kimi Coding Plan" and "fix(ai): point Agnes AI provider at the China
    // gateway" commits on main).
    expect(registry.routes().filter((route) => route.route !== 'deepseek')).toHaveLength(11)
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
