import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { Context } from '@agnes/cordis'
import { fakeSeams, testFsPolicy } from '@agnes/core/testkit'
import type { ModelAdapter, ModelAdapterInstance } from '@agnes/extension-api'
import { resolveProfile } from '@agnes/host-common/profile/resolve'
import { MemoryPackageLoader, type PackageModule } from '@agnes/host-extensions/assemble/packages'
import { createMemoryAudit } from '@agnes/host-infrastructure/audit'
import {
  installModelAdapters,
  ModelAdapterRegistry,
  modelAdapterCatalog,
} from '@agnes/host-providers/assemble/model-adapters'
import { assemble } from '../../src/runtime/assemble/assemble.js'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import type { InferenceEvent, RequestBody } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { attachTestSeamPlugins } from '../../testkit/cordis-seams.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const definition = (over: Partial<ModelAdapter> = {}): ModelAdapter => ({
  id: 'custom',
  api: 'custom-wire',
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
    release = ctx.modelAdapters.register(
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
  expect(modelAdapterCatalog(root)[0]).toMatchObject({ id: 'custom', version: '1.0.0' })
  expect(Object.isFrozen(modelAdapterCatalog(root)[0]?.capabilities)).toBe(true)
  expect(() => root.modelAdapters.register(definition())).toThrow('duplicate model adapter')
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

it('cleans up an instance whose asynchronous factory finishes after unregistering', async () => {
  const root = new Context()
  installModelAdapters(root)
  let finish!: (instance: ModelAdapterInstance) => void
  let disposed = false
  const release = root.modelAdapters.register(
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
  mkdirSync(join(secretPath, 'fixture'), { recursive: true })
  if (!missingCredential)
    writeFileSync(join(secretPath, 'fixture', 'model'), '  synthetic-community-key  ', { mode: 0o600 })
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
              version: '1.2.3',
              integrity: `sha256-${'2'.repeat(64)}`,
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
        provider: {
          package: '@agnes/ai',
          adapters: ['@agnes/ai', selected],
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
      seams: Object.fromEntries(
        Object.entries(seams).map(([name, value]) => [
          name,
          async () =>
            name === 'sandbox'
              ? { ...seams.sandbox, fsPolicy: () => testFsPolicy(realpathSync.native(dataDir)) }
              : value,
        ]),
      ),
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
      const namespace = (await import(pathToFileURL(file).href)) as Record<string, unknown>
      if (file.endsWith('/index.ts')) fixtureNamespace = namespace as typeof fixtureNamespace
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
  if (!fixtureNamespace) throw new Error('fixture was not imported')
  const module = fixtureNamespace
  return { assembled, module, imported }
}

it.each(['@community/fake-model-adapter', 'community-fake'])(
  'loads an external package through its manifest and plugin snapshot, selects %s and calls its wire adapter',
  async (selected) => {
    const { assembled, module, imported } = await fixture(selected)
    try {
      expect(imported.some((file) => file.endsWith('/index.ts'))).toBe(true)
      expect(assembled.modelAdapterCatalog()).toContainEqual({
        id: 'community-fake',
        api: 'fake-wire-v1',
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
  { selected: 'missing-adapter', missingCredential: false, code: 'E_DEP_MISSING' },
  { selected: 'community-fake', missingCredential: true, code: 'E_SEAM_INIT' },
])(
  'refuses before inference for $selected with missing credential $missingCredential',
  async ({ selected, missingCredential, code }) => {
    await expect(fixture(selected, missingCredential)).rejects.toMatchObject({
      code,
      ...(missingCredential
        ? { message: expect.stringContaining('SECRET_UNRESOLVED') }
        : { detail: { reason: 'adapter-missing', id: selected } }),
    })
  },
)
