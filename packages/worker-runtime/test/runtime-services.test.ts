import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { createPlatform, type Host, type LockState, resolveProfile } from '@agnes/host'
import { type JsonValue, jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  type SchemaRef,
} from '@agnes/protocol/runtime'
import { expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({ host: undefined as Host | undefined }))
vi.mock('@agnes/host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/host')>()
  return {
    ...actual,
    // Observe the default worker path after real Host assembly; no fake Host or buildHost injection.
    createHost: async (...args: Parameters<typeof actual.createHost>) => {
      const host = await actual.createHost(...args)
      captured.host = host
      return host
    },
  }
})

import { runWorker } from '../src/main.js'

// Current startup baseline. Every additional selected service must update this expectation and
// document the trusted startup inputs that make its registration possible. The disposable package
// cache is empty bootstrap state, not an installation source; these checks never refresh or fetch.
const baseline = {
  'agh.package-source': ['discover', 'resolveMetadata'],
  'agh.package-resolver': ['resolve'],
}

async function expectStartupBaseline(services: Host['runtimeServices']) {
  const selected: string[] = []
  const refs: Readonly<Record<string, Readonly<Record<string, { input: SchemaRef }>>>> =
    RuntimeMethodSchemaRefs
  const inputs: Record<string, JsonValue> = {
    discover: { query: '', cursor: null, limit: 10 },
    resolveMetadata: { packageId: 'fixture.missing', version: '1.0.0' },
    resolve: {
      requirements: [],
      installedLock: { entries: [], digest: canonicalJsonDigest([]) },
      allowedSources: [],
      platform: 'test',
      apiVersions: [],
    },
  }
  for (const [contract, definition] of Object.entries(RuntimeServiceCatalog)) {
    const found = services.dependencies.get({
      contract,
      major: definition.major,
      logicalName: 'default',
      scope: 'runtime',
      features: [],
      optional: false,
    })
    if (!Object.hasOwn(baseline, contract)) {
      expect(found, contract).toMatchObject({
        ok: false,
        error: { code: 'incompatible', detailCode: 'service_not_registered' },
      })
      continue
    }
    expect(found.ok, contract).toBe(true)
    if (!found.ok) throw new Error(`missing startup service: ${contract}`)
    selected.push(contract)
    const service = found.value
    expect(service.binding.contract).toBe(contract)
    // Maintenance methods have no port on the selected binding, including refresh/fetch.
    expect(service).not.toHaveProperty('maintenance')
    const context = services.contextFor(service.binding)
    const registered: string[] = []
    for (const [method, metadata] of Object.entries(definition.methods)) {
      if (metadata.kind !== 'query' && metadata.kind !== 'compute') continue
      const kind = metadata.kind === 'query' ? 'query' : 'compute'
      const value = inputs[method] ?? {}
      const schema = refs[contract]?.[method]?.input
      if (!schema) throw new Error(`missing public method schema: ${contract}/${method}`)
      const request = {
        target: service.binding,
        method,
        input: {
          kind: 'inline' as const,
          schema,
          value,
          digest: canonicalJsonDigest(value),
          bytes: new TextEncoder().encode(jcs(value)).byteLength,
        },
      }
      const result = await service[kind](request, context)
      if (
        !result.ok &&
        ['method_not_registered', 'method_unavailable'].includes(result.error.detailCode ?? '')
      )
        continue
      registered.push(method)
      if (method === 'resolveMetadata') {
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'denied', detailCode: 'cache_miss' },
        })
      } else if (method === 'discover') {
        expect(result).toMatchObject({
          ok: true,
          value: { kind: 'value', output: { kind: 'inline', value: { items: [] } } },
        })
      } else if (method === 'resolve') {
        expect(result).toMatchObject({
          ok: true,
          value: { kind: 'inline', value: { conflicts: [], lockGraph: { entries: [] } } },
        })
      }
      await expect(
        service[kind]({ ...request, method: 'unregisteredBaselineMethod' }, context),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'incompatible', detailCode: 'method_not_registered' },
      })
    }
    expect(registered.sort(), contract).toEqual(baseline[contract as keyof typeof baseline].slice().sort())
  }
  expect(selected.sort()).toEqual(Object.keys(baseline).sort())
}

it('pins the current service-root baseline through the real default worker Host startup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-worker-entry-services-'))
  const frames: string[] = []
  const link = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      frames.push(String(chunk))
      done()
    },
  })
  try {
    const lock: LockState = {
      packages: Object.fromEntries(
        ['@agnes/ai', '@agnes/base', '@agnes/code'].map((id) => [
          id,
          {
            version: '0.1.0',
            integrity: 'sha512-fixture',
            trust: 'builtin',
            enabled: true,
          },
        ]),
      ),
    }
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        lock,
        user: {
          name: 'local-dev',
          computerUse: { enabled: false },
          provider: {
            package: '@agnes/ai',
            adapters: ['@agnes/ai'],
            routes: [
              {
                route: 'fixture',
                api: 'openai-completions',
                baseUrl: 'http://127.0.0.1:1/v1',
                models: [
                  {
                    id: 'fixture',
                    name: 'fixture',
                    route: 'fixture',
                    api: 'openai-completions',
                    baseUrl: 'http://127.0.0.1:1/v1',
                    reasoning: false,
                    input: ['text'],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 10000,
                    maxTokens: 1000,
                    toolCallFormats: ['native'],
                    thinkingReplay: 'native',
                    contract_id: null,
                  },
                ],
              },
            ],
          },
        },
      },
      {
        platform: createPlatform().snapshot(),
        agnesVersion: '0.0.0',
        now: '2026-10-03T00:00:00Z',
        homeDir: root,
      },
    )
    mkdirSync(profile.cacheDir, { recursive: true })
    const file = join(root, 'profile.json')
    writeFileSync(file, JSON.stringify(profile))
    await runWorker(
      {
        AGNES_WORKER_TOKEN: 'fixture-token',
        AGNES_SUPERVISOR_SOCKET: join(root, 'supervisor.sock'),
        AGNES_WORKER_KEY: '@shared',
        AGNES_WORKER_KIND: 'session',
        AGNES_PROFILE_FILE: file,
        AGNES_WORKER_GENERATION: '1',
        AGNES_WORKER_ROOT: root,
        AGH_HOME: root,
        HOME: root,
      },
      { connect: async () => link, gate: null },
    )
    expect(frames.map((frame) => JSON.parse(frame))).toContainEqual(
      expect.objectContaining({ kind: 'hello' }),
    )
    const host = captured.host
    if (!host) throw new Error('default worker did not assemble a real Host')
    await expectStartupBaseline(host.runtimeServices)
  } finally {
    // No session or resource snapshot was opened; detach executable exit callbacks before teardown.
    link.removeAllListeners()
    link.destroy()
    await captured.host?.close()
    captured.host = undefined
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
