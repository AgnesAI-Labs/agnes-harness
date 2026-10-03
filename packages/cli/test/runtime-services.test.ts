import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlatform, type Host, resolveProfile } from '@agnes/host'
import { type JsonValue, jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  type SchemaRef,
} from '@agnes/protocol/runtime'
import { expect, it, vi } from 'vitest'
import { createPackagedHost } from '../launch/packaged-host.js'
import { assembleLocalHost } from '../src/boot/local.js'
import { TEST_LOCK, testDeps } from './boot-host.js'

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

it.each(['local', 'packaged'] as const)(
  'pins the current service-root baseline through the real %s Host startup',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-cli-entry-services-'))
    let host: Host | undefined
    try {
      const profile = await resolveProfile(
        {
          builtin: 'local-dev',
          lock: TEST_LOCK,
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
      const prompter = { ask: async () => 'unavailable' as const }
      if (mode === 'packaged') {
        // Supply the same declared manifests embedded by build:local, without replacing createHost.
        for (const id of ['base', 'code']) {
          const directory = fileURLToPath(new URL(`../../${id}/`, import.meta.url))
          const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
            agnes: { extensions: string[] }
          }
          vi.stubGlobal(
            `AGNES_${id.toUpperCase()}_EXTENSION_MANIFESTS`,
            pkg.agnes.extensions.map((path) =>
              JSON.parse(readFileSync(join(directory, path, 'agnes.extension.json'), 'utf8')),
            ),
          )
        }
        const entryFile = fileURLToPath(new URL('../dist/local/agnes.mjs', import.meta.url))
        expect(
          existsSync(entryFile),
          'prepare the local runtime with pnpm --filter @agnes/cli build:local',
        ).toBe(true)
        host = await createPackagedHost(profile, prompter, { home: root, cwd: root, entryFile })
      } else {
        const { createHostImpl: _drop, ...deps } = testDeps(root)
        host = await assembleLocalHost(profile, profile.name, root, deps, prompter)
      }
      await expectStartupBaseline(host.runtimeServices)
    } finally {
      await host?.close()
      vi.unstubAllGlobals()
      rmSync(root, { recursive: true, force: true })
    }
  },
  60_000,
)
