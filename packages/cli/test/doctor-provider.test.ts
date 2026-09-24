import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, NullContractStore } from '@agnes/ai'
import { FakeAdapter, fakeModel } from '@agnes/ai/testkit'
import { createTestHost } from '@agnes/host/testkit'
import { expect, it } from 'vitest'
import { doctorProvider } from '../src/commands/doctor-provider.js'

// The local-dev template turns Computer Use on by default (host/templates/local-dev.yaml), and
// createTestHost's fake platform reports the real host OS -- so a bare createTestHost() on this
// machine tries to talk to the real, unsigned/ungranted macOS driver and fails assembly outright.
// These tests exercise provider diagnostics, not Computer Use, so they opt out explicitly.
// createTestHost's own `user` layer always sets `name` to its `template` option (default
// 'local-dev'); this override must repeat that name because ProfileInputs.user is a full
// RuntimeProfileManifest, and it lands after createTestHost's own `name: template` in the object
// spread testkit builds, so it would otherwise clobber it.
const NO_COMPUTER_USE = {
  profileInputs: { user: { name: 'local-dev', computerUse: { enabled: false } } },
} as const

it('does not route onboarding-only built-in providers through a default diagnostic probe', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-cli-doctor-'))
  const { host } = await createTestHost({ dataDir, ...NO_COMPUTER_USE })
  try {
    const result = await doctorProvider(host, { signal: new AbortController().signal })
    expect(result).toEqual({
      name: 'provider',
      status: 'warn',
      detail: [
        'configured routes (1): gw',
        'credentials and selected-model inference not checked; rerun with --probe to opt in',
      ],
    })
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
it('does not present a replacement Host without a registry as healthy', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-cli-doctor-no-registry-'))
  const { host } = await createTestHost({ dataDir, script: [], ...NO_COMPUTER_USE })
  try {
    expect(await doctorProvider(host, { signal: new AbortController().signal })).toEqual({
      name: 'provider',
      status: 'fail',
      detail: ['configured provider route has no diagnostic registry'],
    })
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
it('marks an unconfigured profile as not selected without probing its bundled registry', async () => {
  let probes = 0
  const adapter = new FakeAdapter({
    id: 'onboarding-only',
    routes: [{ route: 'built-in', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1' }],
    models: { 'built-in': [fakeModel({ id: 'm', route: 'built-in' })] },
  })
  adapter.probe = async () => {
    probes++
    throw new Error('must not probe')
  }
  const registry = createProvider({
    adapters: [adapter],
    routes: { primary: { route: 'built-in', model: 'm' } },
    clock: Date.now,
    secrets: () => '',
    contract: new NullContractStore(),
  }).registry
  await expect(
    doctorProvider({ provider: { registry }, profile: { provider: { routes: undefined } } } as never, {
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({
    name: 'provider',
    status: 'warn',
    detail: ['no configured provider route selected; no credential or inference probe was run'],
  })
  expect(probes).toBe(0)
})
it('fails locally for an enabled account with no usable credential without assembling or probing', async () => {
  await expect(
    doctorProvider(undefined, {
      signal: new AbortController().signal,
      accounts: [
        {
          accountId: 'missing-key',
          label: 'Missing key',
          providerId: 'deepseek',
          route: 'account-missing-key',
          baseUrl: 'https://unused.invalid',
          model: 'm',
          models: [{ id: 'm', name: 'M' }],
          enabled: true,
          credentialConfigured: false,
        },
      ],
    }),
  ).resolves.toEqual({
    name: 'provider',
    status: 'fail',
    detail: ['enabled accounts missing usable credentials (1): missing-key'],
  })
})
it('fails closed for configured routes absent from the assembled registry with a bounded summary', async () => {
  const registry = createProvider({
    adapters: [],
    routes: { primary: { route: 'absent', model: 'm' } },
    clock: Date.now,
    secrets: () => '',
    contract: new NullContractStore(),
  }).registry
  const names = Array.from({ length: 5 }, (_, index) => `missing-${index}-${'x'.repeat(200)}`)
  const result = await doctorProvider(
    { provider: { registry }, profile: { provider: { routes: names.map((route) => ({ route })) } } } as never,
    { signal: new AbortController().signal },
  )
  expect(result.status).toBe('fail')
  expect(result.detail[0]).toMatch(/configured routes absent from registry \(5\).*\(\+2 omitted\)/)
  expect(result.detail.join('\n')).not.toContain('x'.repeat(97))
})
it('never serialises opaque provider detail in either probe output form', async () => {
  const adapter = new FakeAdapter({
    id: 'safe-probe',
    routes: [{ route: 'safe', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1' }],
    models: { safe: [fakeModel({ id: 'm', route: 'safe' })] },
  })
  adapter.probe = async () => ({
    route: 'safe',
    ok: false,
    latencyMs: 1,
    checks: [
      {
        name: 'models_endpoint',
        ok: false,
        detail: 'status=401 https://provider.invalid/models?opaque_synthetic_secret=only-for-test',
      },
    ],
  })
  const registry = createProvider({
    adapters: [adapter],
    routes: { primary: { route: 'safe', model: 'm' } },
    clock: Date.now,
    secrets: () => '',
    contract: new NullContractStore(),
  }).registry
  const host = { provider: { registry }, profile: { provider: { routes: [{ route: 'safe' }] } } } as never
  const text = await doctorProvider(host, { signal: new AbortController().signal, probe: true })
  expect(text.status).toBe('fail')
  expect(text.detail[0]).toBe('route probe failed (1): safe')
  expect(text.detail.join('\n')).not.toContain('opaque_synthetic_secret')
  const json = await doctorProvider(host, { signal: new AbortController().signal, probe: true, json: true })
  expect(json.detail.join('\n')).not.toContain('opaque_synthetic_secret')
  expect(JSON.parse(json.detail[0] ?? '')).toMatchObject({
    routes: [{ adapter: 'provider', checks: [{ detail: 'E_PROVIDER_PROBE_FAILED' }] }],
  })
})
it('consumes actual Registry diagnostics through an assembled Host and honours cancellation', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-cli-doctor-registry-'))
  const adapter = new FakeAdapter({
    id: 'diagnostic',
    routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1' }],
    models: { gw: [fakeModel({ id: 'm1', route: 'gw' })] },
  })
  let probes = 0
  adapter.probe = async () => {
    probes++
    return {
      route: 'gw',
      ok: true,
      latencyMs: 0,
      checks: [
        {
          name: 'minimal_inference',
          ok: true,
          detail: JSON.stringify({
            modelId: 'm1',
            thinking: true,
            nativeToolCalls: true,
            usageComplete: true,
          }),
        },
      ],
    }
  }
  const { host } = await createTestHost({
    dataDir,
    ...NO_COMPUTER_USE,
    provider: (_profile, opts) =>
      createProvider({
        ...opts,
        contract: opts.contractStore,
        adapters: [adapter],
        routes: { primary: { route: 'gw', model: 'm1' } },
        clock: Date.now,
        secrets: () => '',
      }),
  })
  try {
    expect((await doctorProvider(host, { signal: new AbortController().signal })).status).toBe('warn')
    expect(probes).toBe(0)
    expect((await doctorProvider(host, { signal: new AbortController().signal, probe: true })).status).toBe(
      'ok',
    )
    expect(probes).toBe(1)
    expect((await doctorProvider(host, { signal: AbortSignal.abort(), probe: true })).status).toBe('fail')
    expect(probes).toBe(1)
    expect(
      await doctorProvider(host, { signal: new AbortController().signal, timeoutMs: 0, probe: true }),
    ).toEqual({
      name: 'provider',
      status: 'fail',
      detail: ['provider diagnostic failed'],
    })
  } finally {
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
