import { closeSync, cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { Context } from '@agnes/cordis'
import { fakeSeams, testFsPolicy } from '@agnes/core/testkit'
import type { ModelAdapter, ModelAdapterInstance } from '@agnes/extension-api'
import { modelAdapterKind } from '@agnes/extension-api'
import { SEAM_KINDS } from '@agnes/extension-api/seams'
import { resolveProfile } from '@agnes/host-common/profile/resolve'
import { MemoryPackageLoader, type PackageModule } from '@agnes/host-extensions/assemble/packages'
import { createMemoryAudit } from '@agnes/host-infrastructure/audit'
import {
  builtinModelAdapterCatalog,
  builtinModelSelectionData,
  installModelAdapters,
  ModelAdapterRegistry,
  modelAdapterCatalog,
} from '@agnes/host-providers/assemble/model-adapters'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import type { InferenceEvent, RequestBody } from '@agnes/protocol'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { afterEach, expect, it, vi } from 'vitest'
import { assemble } from '../../src/runtime/assemble/assemble.js'
import { modelCatalogPublisher } from '../../src/runtime/profile/model-catalog-publication.js'
import { attachTestSeamPlugins, seamFactories } from '../../testkit/cordis-seams.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const definition = (over: Partial<ModelAdapter> = {}): ModelAdapter => ({
  id: 'custom',
  wireApi: 'custom-wire',
  version: '1.0.0',
  capabilities: { imageInput: false, tools: true, streaming: true },
  create: (config) => ({
    id: 'custom-wire',
    routes: () => [...config.routes],
    models: () => [],
    async *stream() {
      yield { type: 'done', reason: 'stop' }
    },
  }),
  ...over,
})

it('registers factories with immutable metadata, rejects duplicates and releases them with the plugin', async () => {
  const root = new Context()
  new ModelAdapterRegistry(root)
  const lifecycle: string[] = []
  let release: (() => Promise<void>) | undefined
  const plugin = root.plugin((ctx) => {
    release = ctx.providers.registerHost(
      modelAdapterKind,
      '@agnes/host',
      definition({
        create: (config) => ({
          ...(definition().create(config) as ModelAdapterInstance),
          dispose() {
            lifecycle.push('instance')
          },
        }),
        cleanup() {
          lifecycle.push('registration')
        },
      }),
    )
  })
  await expect.poll(() => modelAdapterCatalog(root).length).toBe(1)
  expect(modelAdapterCatalog(root)[0]).toMatchObject({
    id: 'custom',
    version: '1.0.0',
    wireApi: 'custom-wire',
  })
  expect(modelAdapterCatalog(root)[0]).not.toHaveProperty('api')
  expect(() =>
    root.providers.registerHost(modelAdapterKind, '@agnes/host', {
      ...definition(),
      wireApi: undefined,
      api: 'custom-wire',
    } as never),
  ).toThrow('invalid model adapter registration')
  expect(Object.isFrozen(modelAdapterCatalog(root)[0]?.capabilities)).toBe(true)
  expect(() => root.providers.registerHost(modelAdapterKind, '@agnes/host', definition())).toThrow(
    'duplicate model adapter',
  )
  const instance = await root.modelAdapters.create('custom', { routes: [] })
  await plugin.dispose()
  expect(lifecycle).toEqual(['instance', 'registration'])
  expect(modelAdapterCatalog(root)).toEqual([])
  expect(() =>
    instance.adapter.stream('custom', body(), {
      signal: new AbortController().signal,
      toolNames: [],
      sessionKey: 'fixture',
      timeoutMs: { firstToken: 100, total: 100 },
    }),
  ).toThrow('model adapter instance is disposed')
  await instance.dispose()
  await release?.()
  expect(lifecycle).toEqual(['instance', 'registration'])
  await expect(root.modelAdapters.create('custom', { routes: [] })).rejects.toMatchObject({
    code: 'E_PROVIDER_UNKNOWN',
  })
  await root.fiber.dispose()
})

it('validates payload capabilities at registration and carries them into the catalog', async () => {
  const root = new Context()
  new ModelAdapterRegistry(root)
  const register = (id: string, capabilities: Record<string, unknown>) =>
    root.providers.registerHost(
      modelAdapterKind,
      '@agnes/host',
      definition({
        id,
        capabilities: { imageInput: false, tools: false, streaming: false, ...capabilities } as never,
      }),
    )
  expect(() => register('bad-type', { payload: 'yes' })).toThrow('invalid model adapter registration')
  expect(() => register('bad-only-type', { payload: true, payloadOnly: 1 })).toThrow(
    'invalid model adapter registration',
  )
  expect(() => register('only-without-payload', { payloadOnly: true })).toThrow(
    'invalid model adapter registration',
  )
  expect(modelAdapterCatalog(root)).toEqual([])
  register('plain', {})
  register('payload', { payload: true })
  register('payload-only', { payload: true, payloadOnly: true })
  const capabilities = (id: string) =>
    modelAdapterCatalog(root).find((entry) => entry.id === id)?.capabilities
  expect(capabilities('plain')).toEqual({ imageInput: false, tools: false, streaming: false })
  expect(capabilities('payload')).toEqual({
    imageInput: false,
    tools: false,
    streaming: false,
    payload: true,
  })
  expect(capabilities('payload-only')).toEqual({
    imageInput: false,
    tools: false,
    streaming: false,
    payload: true,
    payloadOnly: true,
  })
  expect(Object.isFrozen(capabilities('payload-only'))).toBe(true)
  await root.fiber.dispose()
})

// The facade refuses a payload for any adapter that is not marked as reading one. For an assembled
// adapter that mark comes from the registration's declared capabilities, not from the instance the
// factory returned: an instance is free to claim anything, and only the declaration is reviewed.
it('marks an assembled adapter as payload-accepting only when its registration declares it', async () => {
  const root = new Context()
  new ModelAdapterRegistry(root)
  const register = (id: string, capabilities: Record<string, unknown>, instanceClaim?: boolean) =>
    root.providers.registerHost(
      modelAdapterKind,
      '@agnes/host',
      definition({
        id,
        capabilities: { imageInput: false, tools: false, streaming: false, ...capabilities } as never,
        create: (config) =>
          ({
            ...(definition().create(config) as ModelAdapterInstance),
            ...(instanceClaim === undefined ? {} : { acceptsPayload: instanceClaim }),
          }) as ModelAdapterInstance,
      }),
    )
  register('plain', {})
  register('declared-off', { payload: false })
  register('declared', { payload: true })
  register('declared-only', { payload: true, payloadOnly: true })
  register('claims-without-declaring', {}, true)
  const accepts = async (id: string) =>
    (await root.modelAdapters.create(id, { routes: [] })).adapter.acceptsPayload
  expect(await accepts('declared')).toBe(true)
  expect(await accepts('declared-only')).toBe(true)
  expect(await accepts('plain')).toBe(false)
  expect(await accepts('declared-off')).toBe(false)
  expect(await accepts('claims-without-declaring')).toBe(false)
  await root.fiber.dispose()
})

it('cleans up an instance whose asynchronous factory finishes after unregistering', async () => {
  const root = new Context()
  installModelAdapters(root)
  let finish!: (instance: ModelAdapterInstance) => void
  let disposed = false
  const release = root.providers.registerHost(
    modelAdapterKind,
    '@agnes/host',
    definition({
      create: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    }),
  )
  const pending = root.modelAdapters.create('custom', { routes: [] })
  const unloading = release()
  let drained = false
  void unloading.then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  finish({
    ...(definition().create({ routes: [] }) as ModelAdapterInstance),
    dispose() {
      disposed = true
    },
  })
  await expect(pending).rejects.toThrow()
  await unloading
  expect(disposed).toBe(true)
  await root.fiber.dispose()
})

const body = (): RequestBody => ({
  kind: 'inference',
  sessionKey: 'adapter-fixture',
  slot: 'primary',
  route: 'fixture',
  model: 'fake-model',
  contractId: null,
  derivedHash: 'a'.repeat(64),
  system: 'fixture',
  tools: [],
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
      ],
    },
  ],
})

async function fixture(selected: string, missingCredential = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-model-adapter-'))
  dirs.push(dataDir)
  const directory = join(dataDir, 'snapshot')
  cpSync(fileURLToPath(new URL('../fixtures/model-adapter', import.meta.url)), directory, { recursive: true })
  const source: RuntimePluginSnapshot = {
    snapshot: {
      packageId: '@community/fake-model-adapter',
      version: '1.2.3',
      snapshotId: `sha256-${'1'.repeat(64)}`,
      integrity: `sha256-${'2'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'fixture',
      directory,
      profile: 'local-dev',
      contributions: [],
    },
    generation: 1,
    trusted: true,
  }
  const secretPath = join(dataDir, 'secrets')
  createPrivateDirectorySync(secretPath)
  createPrivateDirectorySync(join(secretPath, 'fixture'))
  if (!missingCredential) {
    closeSync(createPrivateFileSync(join(secretPath, 'fixture', 'model')))
    writeFileSync(join(secretPath, 'fixture', 'model'), '  synthetic-community-key  ', { mode: 0o600 })
  }
  const model = fakeModel({
    id: 'fake-model',
    route: 'fixture',
    api: 'community-fake',
    input: ['text', 'image'],
  })
  const profile = await resolveProfile(
    {
      builtin: 'local-dev',
      lock: {
        packages: Object.fromEntries(
          ['@agnes/ai', '@agnes/base', '@agnes/code', source.snapshot.packageId].map((id) => [
            id,
            {
              version: id === source.snapshot.packageId ? '1.2.3' : '0.1.0',
              source:
                id === source.snapshot.packageId
                  ? { type: 'file' as const, ref: 'file:fixture' }
                  : { type: 'builtin' as const, ref: 'builtin' },
              integrity: id === source.snapshot.packageId ? `sha256-${'2'.repeat(64)}` : 'builtin:0.1.0',
              trust: id === source.snapshot.packageId ? 'trusted' : 'builtin',
              enabled: true,
            },
          ]),
        ),
      },
      user: {
        name: 'local-dev',
        presets: { default: 'standard', allowed: ['standard'] },
        adapters: { secrets: { kind: 'file', path: secretPath } },
        packages: [{ id: source.snapshot.packageId, source: `file:${directory}` }],
        providers: { 'model-adapter': { provider: ['@agnes/ai', selected] } },
        provider: {
          package: '@agnes/ai',
          catalog: { include: [] },
          routes: [
            {
              route: 'fixture',
              api: 'community-fake',
              baseUrl: 'https://fake.invalid',
              credentialRef: 'secret://fixture/model',
              models: [model],
            },
          ],
        },
      },
    },
    {
      platform: { os: 'linux', arch: 'x64', capabilities: {} },
      agnesVersion: '0.1.0',
      now: '2026-10-07T00:00:00Z',
    },
  )
  const seams = fakeSeams()
  const modules: Record<string, PackageModule> = {
    '@agnes/ai': { id: '@agnes/ai' },
    '@agnes/base': {
      id: '@agnes/base',
      ...seamFactories(Object.fromEntries(SEAM_KINDS.map((name) => [name, async () => seams[name]]))),
      presets: { base: { name: 'base' } },
    },
    '@agnes/code': {
      id: '@agnes/code',
      presets: { standard: { name: 'standard', extends: 'base', disclosure: 'standard' } },
    },
  }
  attachTestSeamPlugins(modules['@agnes/base'] as PackageModule)
  const imported: string[] = []
  let fixtureNamespace:
    | {
        observations: { requests: Array<{ model: string }>; disposed: boolean; cleaned: boolean }
      }
    | undefined
  const extensionLoader = {
    import: async (file: string) => {
      imported.push(file)
      // The copied snapshot has no node_modules; import the original so the kind token resolves like a Host-provided external.
      // The loader hands over native paths (Windows expands 8.3 names), so compare in that spelling.
      const root = realpathSync.native(directory)
      const origin = file.startsWith(root)
        ? fileURLToPath(new URL(`../fixtures/model-adapter${file.slice(root.length)}`, import.meta.url))
        : file
      const namespace = (await import(`${pathToFileURL(origin).href}?run=${basename(dataDir)}`)) as Record<
        string,
        unknown
      >
      if (basename(file) === 'index.ts') fixtureNamespace = namespace as typeof fixtureNamespace
      return namespace
    },
  }
  const assembled = await assemble(profile, {
    dataDir,
    workspaceRoot: dataDir,
    profileDir: join(dataDir, 'profiles'),
    homeDir: dataDir,
    hostRoot: process.cwd(),
    loader: new MemoryPackageLoader(modules),
    packageDirs: new Map(
      profile.packages.map((pkg) => [pkg.id, pkg.id === source.snapshot.packageId ? directory : dataDir]),
    ),
    runtimePluginSnapshots: [source],
    extensionLoader,
    audit: createMemoryAudit(),
    log: { info() {}, debug() {}, warn() {}, error() {} },
  })
  if (!fixtureNamespace) {
    await assembled.rollback.unwind()
    throw new Error('fixture was not imported')
  }
  const module = fixtureNamespace
  return { assembled, module, imported }
}

it.each(['@community/fake-model-adapter', 'community-fake'])(
  'loads an external package through its manifest and plugin snapshot, selects %s and calls its wire adapter',
  async (selected) => {
    const { assembled, module, imported } = await fixture(selected)
    try {
      expect(imported.some((file) => basename(file) === 'index.ts')).toBe(true)
      expect(assembled.modelAdapterCatalog()).toContainEqual({
        id: 'community-fake',
        wireApi: 'fake-wire-v1',
        version: '1.2.3',
        sourcePackage: '@community/fake-model-adapter',
        capabilities: { imageInput: true, tools: true, streaming: true },
      })
      const events: InferenceEvent[] = []
      for await (const event of assembled.provider.infer(body(), {
        signal: new AbortController().signal,
        toolNames: [],
      }))
        events.push(event)
      expect(events).toContainEqual({ type: 'text_delta', delta: 'community adapter called' })
      expect(module.observations.requests).toEqual([
        { model: 'fake-model', image: true, credential: 'synthetic-community-key' },
      ])
      expect(module.observations.disposed).toBe(false)
    } finally {
      await assembled.rollback.unwind()
    }
    expect(module.observations.disposed).toBe(true)
    expect(module.observations.cleaned).toBe(true)
  },
)

it.each([
  { selected: 'missing-adapter', missingCredential: false, code: 'E_SEAM_INIT' },
  { selected: 'community-fake', missingCredential: true, code: 'E_SECRET_UNRESOLVED' },
])(
  'refuses before inference for $selected with missing credential $missingCredential',
  async ({ selected, missingCredential, code }) => {
    await expect(fixture(selected, missingCredential)).rejects.toMatchObject({
      code,
      ...(missingCredential
        ? { message: expect.stringContaining('SECRET_UNRESOLVED') }
        : { detail: { reason: 'provider-unknown' } }),
    })
  },
)

it('reads release adapter identities and capabilities without assembling a Host', async () => {
  const builtin = new Map(builtinModelAdapterCatalog().map((entry) => [entry.id, entry.capabilities]))
  expect(builtin.get('typesafe-systemone')).toMatchObject({ payload: true, payloadOnly: true })
  // Every conversation adapter declares neither payload key.
  for (const id of ['openai-completions', 'anthropic-messages', 'openai'])
    expect(builtin.get(id)).toEqual({ imageInput: true, tools: true, streaming: true })
  const profile = await resolveProfile(
    { builtin: 'local-dev' },
    {
      platform: { os: 'darwin', arch: 'arm64', capabilities: {} },
      agnesVersion: '0.0.0',
      now: '2026-10-18',
      homeDir: '/synthetic',
    },
  )
  const data = await builtinModelSelectionData({
    ...profile,
    packages: [
      ...profile.packages.filter((pkg) => pkg.id !== '@agnes/model-adapters'),
      {
        id: '@agnes/model-adapters',
        version: '0.0.0',
        integrity: 'builtin:0.0.0',
        source: 'builtin',
        trust: 'builtin',
        enabled: true,
      },
    ],
  })
  expect(data.adapters.find((a) => a.id === 'openai-completions')?.sourcePackage).toBe('@agnes/ai')
  for (const id of ['scripted', 'replay', 'local-openai'])
    expect(data.adapters.find((a) => a.id === id)).toBeUndefined()
  expect(builtinModelAdapterCatalog().find((a) => a.id === 'scripted')?.sourcePackage).toBe('@agnes/ai')
  const directory = mkdtempSync(join(tmpdir(), 'agh-model-display-'))
  dirs.push(directory)
  const file = join(directory, '.agnes-published-model-adapters.json')
  writeFileSync(file, 'stale community projection')
  const sources = vi.fn(async (): Promise<RuntimePluginSnapshot[]> => {
    throw new Error('unrelated package scan must not run')
  })
  const warn = vi.fn()
  await modelCatalogPublisher(
    { modelAdapterCatalog: builtinModelAdapterCatalog, provider: { models: () => [] } } as never,
    { profileDir: directory, runtimePluginSources: sources, log: { warn } } as never,
    () => profile,
  )()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    version: 1,
    profileHash: profile.hash,
    entries: [],
  })
  expect(sources).not.toHaveBeenCalled()
  expect(warn).not.toHaveBeenCalled()
  const adapter = { ...builtinModelAdapterCatalog()[0]!, sourcePackage: 'acme/models' }
  const source: RuntimePluginSnapshot = {
    generation: 1,
    trusted: true,
    snapshot: {
      profile: profile.name,
      packageId: 'acme/models',
      snapshotId: `sha256-${'1'.repeat(64)}`,
      version: '1.0.0',
      integrity: `sha256-${'2'.repeat(64)}`,
      treeIntegrity: `sha256-${'3'.repeat(64)}`,
      capabilityHash: '4'.repeat(64),
      directory,
      contributions: [],
    },
  }
  const publish = modelCatalogPublisher(
    { modelAdapterCatalog: () => [adapter], provider: { models: () => [] } } as never,
    { profileDir: directory, runtimePluginSources: sources, log: { warn } } as never,
    () => profile,
  )
  sources.mockResolvedValueOnce([source])
  await publish()
  expect(JSON.parse(readFileSync(file, 'utf8')).entries).toMatchObject([
    { adapter: { sourcePackage: 'acme/models' }, source: { snapshotId: source.snapshot.snapshotId } },
  ])
  sources.mockResolvedValueOnce([{ ...source, trusted: false }])
  await publish()
  expect(JSON.parse(readFileSync(file, 'utf8')).entries).toEqual([])
  expect(warn).not.toHaveBeenCalled()
})
