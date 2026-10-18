import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import type { ResolvedProfile } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { publishModelAdapterCatalog, type RuntimePluginSnapshot } from '@agnes/package-manager'
import type { ApisListResult, RouteDecl } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
import { readModelSelectionCatalog } from '../src/supervisor/model-adapter-lookup.js'

const chatModel = fakeModel({ id: 'chat-1', route: 'gw' })
const jevModel = fakeModel({ id: 'jev-1', route: 'jev', api: 'typesafe-systemone', input: ['text'] })
const acmeModel = fakeModel({ id: 'acme-1', route: 'acme-route', api: 'acme-wire', input: ['text'] })
const route = (name: string, api: string, model: typeof chatModel): RouteDecl => ({
  route: name,
  api,
  baseUrl: 'http://127.0.0.1:1/v1',
  models: [model],
})
const adapter = (id: string, capabilities: Record<string, boolean>) => ({
  id,
  version: '1.0.0',
  wireApi: `${id}-wire`,
  sourcePackage: '@acme/adapter',
  capabilities: { imageInput: false, tools: false, streaming: false, ...capabilities },
})
const acmePayloadOnly = adapter('acme', { payload: true, payloadOnly: true })

/** What `apis.list` answers on a supervisor: its host is a profile, its adapters come from `lookup`. */
async function listed(
  declared: RouteDecl[],
  source: RuntimePluginSnapshot | undefined,
  published: readonly (typeof acmePayloadOnly)[] = [],
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnesd-adapter-lookup-'))
  const { host } = await createTestHost({
    dataDir,
    provider: new ScriptedProvider({ scripts: [], models: [chatModel, jevModel] }),
    profileInputs: {
      user: {
        name: 'local-dev',
        provider: {
          package: '@agnes/ai',
          routes: [
            route('gw', 'openai-completions', chatModel),
            route('jev', 'typesafe-systemone', jevModel),
          ],
        },
      },
    },
  })
  // The routes under test are declared on the profile the supervisor serves; the lookup reads the same.
  const profile = {
    ...host.profile,
    provider: { ...host.profile.provider, routes: declared, catalog: { include: [] } },
  }
  const served = new Proxy(host, {
    get: (target, key, receiver) => (key === 'profile' ? profile : Reflect.get(target, key, receiver)),
  })
  const profileDir = join(dataDir, 'profiles', 'local-dev')
  publishModelAdapterCatalog(
    profileDir,
    profile.hash,
    published.map((adapter) => ({ ...adapter, models: [] })),
    source ? [source] : [],
  )
  const ep = createLocalEndpoint(served, {
    clock: () => Date.now(),
    modelAdapters: readModelSelectionCatalog({
      profile: () => profile,
      profileDir,
      sources: async () => (source ? [source] : []),
    }),
  })
  try {
    await ep.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          _meta: { 'ai.agnes.harness': { capabilities: { permission: false } } },
        },
        _meta: { 'ai.agnes.harness': { clientId: 'lookup-test' } },
      },
    })
    const started = Date.now()
    const reply = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: '_agnes/v1/apis.list',
      params: {},
    })) as { result: ApisListResult }
    return {
      models: (reply.result.profile.models ?? []).map((model) => `${model.route}/${model.id}`),
      elapsedMs: Date.now() - started,
    }
  } finally {
    await ep.close()
    await host.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const source: RuntimePluginSnapshot = {
  trusted: true,
  enabled: true,
  generation: 1,
  snapshot: {
    packageId: '@acme/adapter',
    snapshotId: `sha256-${'a'.repeat(64)}`,
    profile: 'local-dev',
    version: '1.0.0',
    integrity: `sha256-${'b'.repeat(64)}`,
    treeIntegrity: `sha256-${'c'.repeat(64)}`,
    capabilityHash: 'd'.repeat(64),
    directory: '/synthetic/verified-adapter',
    contributions: [],
  },
}

it('answers from release registrations and configured models without a worker, excluding payload-only models', async () => {
  const { models } = await listed(
    [route('gw', 'openai-completions', chatModel), route('jev', 'typesafe-systemone', jevModel)],
    undefined,
  )
  expect(models).toEqual(['gw/chat-1'])
})

it('reads a community payload-only description from its verified publication, without session catalog admission', async () => {
  const { models } = await listed(
    [route('gw', 'openai-completions', chatModel), route('acme-route', 'acme', acmeModel)],
    source,
    [acmePayloadOnly],
  )
  expect(models).toEqual(['gw/chat-1'])
})

it('does not reuse a revoked or different-version community publication on a later request', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnesd-model-projection-'))
  const profileDir = join(dataDir, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  let live = [source]
  const profile = {
    hash: 'profile',
    packages: [],
    provider: { routes: [route('acme-route', 'acme', acmeModel)], catalog: { include: [] } },
  } as unknown as ResolvedProfile
  publishModelAdapterCatalog(profileDir, profile.hash, [{ ...acmePayloadOnly, models: [] }], live)
  const read = readModelSelectionCatalog({ profile: () => profile, profileDir, sources: async () => live })
  try {
    expect(await read()).toContainEqual(expect.objectContaining({ id: 'acme' }))
    const adapter = {
      ...acmePayloadOnly,
      capabilities: { ...acmePayloadOnly.capabilities, payloadOnly: false },
      models: [{ id: 'dynamic-1', route: 'acme-route' }],
    }
    let rows = [
      {
        plugin: `${source.snapshot.packageId}@${source.snapshot.snapshotId}/adapter`,
        entryRevision: source.snapshot.snapshotId,
      },
    ]
    const worker = { alive: true, command: async () => ({ modelAdapters: [adapter], sources: rows }) }
    const running = readModelSelectionCatalog({
      profile: () => profile,
      profileDir,
      sources: async () => live,
      worker: () => worker,
    })
    expect(await running()).toContainEqual(
      expect.objectContaining({ models: [{ id: 'dynamic-1', route: 'acme-route' }] }),
    )
    adapter.models = [{ id: 'dynamic-2', route: 'acme-route' }]
    expect(await running()).toContainEqual(
      expect.objectContaining({ models: [{ id: 'dynamic-2', route: 'acme-route' }] }),
    )
    rows = []
    // A removed live registration cannot fall back to an older publication for this same code.
    expect(await running()).not.toContainEqual(expect.objectContaining({ id: 'acme' }))
    live = [{ ...source, snapshot: { ...source.snapshot, version: '2.0.0' } }]
    expect(await read()).not.toContainEqual(expect.objectContaining({ id: 'acme' }))
    live = [{ ...source, trusted: false }]
    expect(await read()).not.toContainEqual(expect.objectContaining({ id: 'acme' }))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
