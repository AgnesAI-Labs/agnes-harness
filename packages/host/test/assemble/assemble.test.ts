import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeRequest, ScriptedProvider } from '@agnes/ai/testkit'
import type { Context } from '@agnes/cordis'
import type { RemoteTransport, SandboxSeam, SeamWorkspace } from '@agnes/core'
import { fakeSeams, testFsPolicy } from '@agnes/core/testkit'
import type { ProviderPluginContext } from '@agnes/extension-api'
import { bundledPackageJson } from '@agnes/extension-api'
import { checkpointKind, SEAM_KINDS } from '@agnes/extension-api/seams'
import { resolveProfile } from '@agnes/host-common/profile/resolve'
import { WorkspaceBindingAuthority } from '@agnes/host-common/workspace-authority'
import {
  loadRuntimePackage,
  MemoryPackageLoader,
  type PackageModule,
} from '@agnes/host-extensions/assemble/packages'
import { createLoader } from '@agnes/host-extensions/ext-host/loader'
import { createCredentialStore } from '@agnes/host-infrastructure/adapters/credential-store'
import { localFsIo } from '@agnes/host-infrastructure/adapters/fs-io-local'
import { type AuditEvent, type AuditSink, createMemoryAudit } from '@agnes/host-infrastructure/audit'
import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import { SessionWorkspaceRuntimeTable } from '@agnes/host-infrastructure/session-workspace-runtime'
import { buildOrdinaryRows, type OrdinaryPluginLayers } from '@agnes/host-providers/assemble/ordinary-rows'
import {
  assertCurrentPackageFormat,
  hashDirectory,
  type RuntimePluginSnapshot,
  type RuntimeSnapshot,
} from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow, normalizePluginExport } from '@agnes/plugin-runtime/host'
import type { Actor, ModelRecord, RouteDecl } from '@agnes/protocol'
import { defineRemoteSandboxProvider } from '@agnes/sandbox-remote'
import { privateArtifactDeleteAvailable } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ASSEMBLY_STEPS, type AssembleDeps, assemble } from '../../src/runtime/assemble/assemble.js'
import { closeHost } from '../../src/runtime/lifecycle/lifecycle.js'
import { attachTestSeamPlugins, testSeams } from '../../testkit/cordis-seams.js'

const MODEL: ModelRecord = {
  id: 'm1',
  name: 'm1',
  api: 'openai',
  route: 'gw',
  baseUrl: 'https://gw.example/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}
const ROUTE: RouteDecl = { route: 'gw', api: 'openai', baseUrl: 'https://gw.example/v1', models: [MODEL] }
const env = {
  platform: { os: 'linux' as const, arch: 'x64', capabilities: {} },
  agnesVersion: '0.1.0',
  now: '2026-09-07T00:00:00Z',
}
const lockPkgs = {
  '@agnes/ai': {
    version: '0.1.0',
    source: { type: 'builtin' as const, ref: 'builtin' },
    integrity: 'builtin:0.1.0',
    trust: 'builtin' as const,
    enabled: true,
  },
  '@agnes/base': {
    version: '0.1.0',
    source: { type: 'builtin' as const, ref: 'builtin' },
    integrity: 'builtin:0.1.0',
    trust: 'builtin' as const,
    enabled: true,
  },
  '@agnes/code': {
    version: '0.1.0',
    source: { type: 'builtin' as const, ref: 'builtin' },
    integrity: 'builtin:0.1.0',
    trust: 'builtin' as const,
    enabled: true,
  },
}
const log = { debug() {}, info() {}, warn() {}, error() {} }
const SEAM_KEYS = [
  'approval',
  'checkpoint',
  'billing',
  'verifier',
  'repair',
  'artifacts',
  'principals',
] as const

async function publishRows(
  assembly: Awaited<ReturnType<typeof assemble>>,
  rows: Parameters<Awaited<ReturnType<typeof assemble>>['pluginTree']['applyRows']>[0],
) {
  return assembly.applyRuntimeTarget(
    buildRuntimeTarget({
      rows,
      resources: { mcp: [], skills: {} },
      resourceRevision: '0'.repeat(64),
      compositeRevision: '0'.repeat(64),
    }),
  )
}

/**
 * Build the ordinary rows one immutable snapshot contributes, the same way assembly does, so a test
 * can hand `applyRuntimeTarget` a desired row for a snapshot the Host has not loaded yet.
 */
async function snapshotOrdinaryRows(
  profile: Awaited<ReturnType<typeof resolveProfile>>,
  source: Readonly<RuntimePluginSnapshot>,
  namespace: Record<string, unknown>,
  layers: OrdinaryPluginLayers = {},
) {
  const loaded = await loadRuntimePackage(source, { import: async () => namespace })
  if (!loaded) throw new Error(`no runtime plugin exports in ${source.snapshot.packageId}`)
  return buildOrdinaryRows(profile, new Map([[source.snapshot.packageId, loaded.module]]), layers).rows
}

function baseModule(over: Partial<PackageModule> = {}): PackageModule {
  const seams = fakeSeams()
  const module: PackageModule = {
    id: '@agnes/base',
    operations: {},
    presets: { base: { name: 'base' } },
    ...over,
  }
  Object.assign(testSeams(module), Object.fromEntries(SEAM_KEYS.map((n) => [n, async () => seams[n]])))
  return attachTestSeamPlugins(module)
}
const codeModule: PackageModule = {
  id: '@agnes/code',
  presets: { standard: { name: 'standard', extends: 'base', disclosure: 'standard' } },
  operations: {},
}
const aiModule: PackageModule = { id: '@agnes/ai' }
const allModules = () => ({ '@agnes/base': baseModule(), '@agnes/code': codeModule, '@agnes/ai': aiModule })
const profileFor = (over: Record<string, unknown> = {}) =>
  resolveProfile(
    {
      builtin: 'local-dev',
      lock: { packages: lockPkgs },
      user: {
        name: 'local-dev',
        presets: { default: 'standard', allowed: ['standard'] },
        provider: { package: '@agnes/ai', routes: [ROUTE] },
        ...over,
      },
    },
    env,
  )
const events = (d: AssembleDeps): AuditEvent[] => (d.audit as AuditSink & { events: AuditEvent[] }).events

describe('assemble', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  // Typed as AssembleDeps rather than cast: the old test wrote `deps({…}) as never` twice, which is
  // exactly how three signature mismatches stayed invisible.
  const deps = (modules: Record<string, PackageModule>, over: Partial<AssembleDeps> = {}): AssembleDeps => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-asm-'))
    dirs.push(dataDir)
    return {
      dataDir,
      profileDir: join(dataDir, 'profiles', 'local-dev'),
      workspaceRoot: dataDir,
      homeDir: dataDir,
      hostRoot: process.cwd(),
      loader: new MemoryPackageLoader(modules),
      audit: createMemoryAudit(),
      log,
      providerFactory: () => new ScriptedProvider({ scripts: [] }),
      agnesVersion: '0.1.0',
      env: { ...process.env },
      ...over,
    }
  }

  const gate = () => {
    let resolve = () => {}
    let reject: (error: Error) => void = () => {}
    const promise = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    return { promise, resolve, reject }
  }
  const prepareSource = (id: string, manifest: Record<string, unknown> = {}): RuntimePluginSnapshot => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-prepare-')))
    dirs.push(directory)
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: id,
        version: '1.0.0',
        exports: './index.js',
        agnes: { plugins: [{ export: 'main', apiRange: '^5.0.0' }] },
        ...manifest,
      }),
    )
    writeFileSync(join(directory, 'index.js'), 'export const main = () => {}\n')
    const integrity = hashDirectory(directory, { exclude: [] })
    return {
      trusted: true,
      generation: 1,
      snapshot: {
        packageId: id,
        profile: 'local-dev',
        version: '1.0.0',
        snapshotId: integrity,
        integrity,
        treeIntegrity: integrity,
        capabilityHash: 'capability',
        directory,
        contributions: [],
      },
    }
  }

  it.each([1, 2, 4])('bounds independent prepare at %i and preserves registration order', async (limit) => {
    const sources = Array.from({ length: 6 }, (_, i) => prepareSource(`@acme/prepare-${i}`))
    const originalProfile = await profileFor()
    const profile = {
      ...originalProfile,
      packages: [
        ...originalProfile.packages,
        ...sources.map(({ snapshot }) => ({
          id: snapshot.packageId,
          source: 'test',
          version: snapshot.version,
          integrity: snapshot.integrity,
          trust: 'trusted' as const,
          enabled: true,
        })),
      ],
    }
    const held = Array.from({ length: limit }, gate)
    const reached = gate()
    const started: string[] = []
    const mounted: string[] = []
    let active = 0
    let peak = 0
    const assembly = assemble(
      profile,
      deps(allModules(), {
        runtimePluginSnapshots: sources,
        ...(limit === 4 ? {} : { runtimePrepareConcurrency: limit }),
        runtimePrepareIndependent: sources.map(({ snapshot }) => snapshot),
        extensionLoader: {
          import: async (file) => {
            const source = sources.find(({ snapshot }) => file.startsWith(snapshot.directory))
            if (!source) throw new Error('unexpected prepare source')
            const index = started.length
            started.push(source.snapshot.packageId)
            peak = Math.max(peak, ++active)
            if (started.length === limit) reached.resolve()
            await held[index]?.promise
            active--
            return {
              main: () => {
                mounted.push(source.snapshot.packageId)
              },
            }
          },
        },
      }),
    )
    void assembly.catch((error) => reached.reject(error))
    await reached.promise
    expect(new Set(started)).toEqual(
      new Set(sources.slice(0, limit).map(({ snapshot }) => snapshot.packageId)),
    )
    expect(mounted).toEqual([])
    for (const heldImport of [...held].reverse()) heldImport.resolve()
    const a = await assembly
    try {
      expect(peak).toBe(limit)
      expect(active).toBe(0)
      expect(mounted).toEqual(sources.map(({ snapshot }) => snapshot.packageId))
    } finally {
      await closeHost(a, new Set(), { timeoutMs: 1000, audit: createMemoryAudit() })
    }
  })

  it.each(['rejected', 'changed'])(
    'drains %s in-flight prepares, collects errors and allows a fresh retry',
    async (kind) => {
      const sources = Array.from({ length: 4 }, (_, i) => prepareSource(`@acme/fail-${i}`))
      const held = [gate(), gate()]
      const reached = gate()
      const secondEntered = gate()
      const started: string[] = []
      let settled = false
      const options = deps(allModules(), {
        crashAt: 'packages',
        runtimePluginSnapshots: sources,
        runtimePrepareConcurrency: 2,
        runtimePrepareIndependent: sources.map(({ snapshot }) => snapshot),
        extensionLoader: {
          import: async (file) => {
            const index = sources.findIndex(({ snapshot }) => file.startsWith(snapshot.directory))
            // Independent imports may arrive in either order; exercise the reverse order explicitly.
            if (index === 0) await secondEntered.promise
            started.push(file)
            if (index === 1) secondEntered.resolve()
            if (started.length === 2) reached.resolve()
            await held[index]?.promise
            return { main: () => {} }
          },
        },
      })
      const profile = await profileFor()
      const outcome = assemble(profile, options)
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true
        })
      void outcome.then((error) => {
        if (error instanceof Error) reached.reject(error)
      })
      await reached.promise
      const changedFile = join(sources[0]?.snapshot.directory ?? '', 'changed.txt')
      if (kind === 'changed') {
        writeFileSync(changedFile, 'changed during import')
        held[0]?.resolve()
      } else held[0]?.reject(new Error('first module failed'))
      await Promise.resolve()
      expect(settled).toBe(false)
      held[1]?.reject(new Error('second module failed'))
      const error = await outcome
      expect(error).toMatchObject({
        code: 'E_EXT_LOAD',
        detail: {
          reason: 'runtime-prepare-failed',
          packages: sources.slice(0, 2).map(({ snapshot }) => snapshot.packageId),
        },
        cause: {
          errors: [
            expect.objectContaining({
              detail: { reason: kind === 'changed' ? 'snapshot-changed' : 'module-import' },
            }),
            expect.objectContaining({ detail: { reason: 'module-import' } }),
          ],
        },
      })
      expect(started).toHaveLength(2)
      if (kind === 'changed') rmSync(changedFile)
      options.extensionLoader = { import: async () => ({ main: () => {} }) }
      await expect(assemble(profile, options)).rejects.toThrow('crash:packages')
    },
  )

  it.each(['unknown', 'updated', 'package-dependency', 'service-dependency'])(
    'keeps %s sources serial even at concurrency 4',
    async (kind) => {
      const first = prepareSource(
        '@acme/serial-a',
        kind === 'package-dependency'
          ? {
              dependencies: { '@acme/serial-b': '^1.0.0' },
            }
          : kind === 'service-dependency'
            ? {
                agnes: { plugins: [{ export: 'main', apiRange: '^5.0.0', inject: ['serial-service'] }] },
              }
            : {},
      )
      const second = prepareSource(
        '@acme/serial-b',
        kind === 'service-dependency'
          ? {
              agnes: { plugins: [{ export: 'main', apiRange: '^5.0.0', provide: ['serial-service'] }] },
            }
          : {},
      )
      const sources = [first, second]
      const reached = gate()
      const held = gate()
      const started: string[] = []
      const outcome = assemble(
        await profileFor(),
        deps(allModules(), {
          crashAt: 'packages',
          runtimePluginSnapshots: sources,
          runtimePrepareConcurrency: 4,
          runtimePrepareIndependent:
            kind === 'unknown'
              ? []
              : sources.map(({ snapshot }) => ({
                  packageId: snapshot.packageId,
                  snapshotId: kind === 'updated' ? 'old-snapshot' : snapshot.snapshotId,
                })),
          extensionLoader: {
            import: async (file) => {
              started.push(file)
              if (file.startsWith(first.snapshot.directory)) {
                reached.resolve()
                await held.promise
              }
              return { main: () => {} }
            },
          },
        }),
      ).catch((error: unknown) => error)
      void outcome.then((error) => {
        if (error instanceof Error) reached.reject(error)
      })
      await reached.promise
      expect(started).toEqual([join(first.snapshot.directory, 'index.js')])
      held.resolve()
      expect(await outcome).toMatchObject({ message: expect.stringContaining('crash:packages') })
      expect(started).toEqual(sources.map(({ snapshot }) => join(snapshot.directory, 'index.js')))
    },
  )

  it.each([
    'duplicate-source',
    'duplicate-row',
    'untrusted',
    'profile',
    'generation',
    'stale',
    'dependency-manifest',
    'identity',
    'isolated',
    'externals',
    'entry',
    'concurrency',
  ])('rejects %s across the full selection before any import', async (kind) => {
    const first = prepareSource('@acme/preflight-a')
    let second = prepareSource(
      '@acme/preflight-b',
      kind === 'dependency-manifest'
        ? { dependencies: { '@acme/example': 42 } }
        : kind === 'identity'
          ? { name: '@acme/wrong' }
          : kind === 'isolated'
            ? { agnes: { plugins: [{ export: 'main', apiRange: '^5.0.0', runtime: 'isolated' }] } }
            : kind === 'externals'
              ? {
                  agnes: {
                    hostProvidedExternals: { 'private-host-module': '*' },
                    plugins: [{ export: 'main', apiRange: '^5.0.0' }],
                  },
                }
              : kind === 'entry'
                ? { exports: '../outside.js' }
                : kind === 'duplicate-row'
                  ? {
                      agnes: {
                        plugins: [
                          { export: 'main', apiRange: '^5.0.0', id: `ext:${first.snapshot.packageId}/main` },
                        ],
                      },
                    }
                  : {},
    )
    if (kind === 'duplicate-source') second = first
    if (kind === 'untrusted') second = { ...second, trusted: false }
    if (kind === 'profile') second = { ...second, snapshot: { ...second.snapshot, profile: 'other-profile' } }
    if (kind === 'generation') second = { ...second, generation: 0 }
    if (kind === 'stale')
      writeFileSync(join(second.snapshot.directory, 'changed.txt'), 'changed before prepare')
    const imported: string[] = []
    const d = deps(allModules(), {
      runtimePluginSnapshots: [first, second],
      runtimePrepareConcurrency: kind === 'concurrency' ? 5 : 4,
      extensionLoader: {
        import: async (file) => {
          imported.push(file)
          return { main: () => {} }
        },
      },
    })
    const builtin = vi.spyOn(d.loader, 'importPackage')
    const outcome = assemble(await profileFor(), d)
    if (kind === 'externals')
      await expect(outcome).rejects.toMatchObject({
        code: 'E_EXT_LOAD',
        detail: { reason: 'external-unavailable', module: 'private-host-module' },
      })
    else await expect(outcome).rejects.toThrow()
    expect(imported).toEqual([])
    expect(builtin).not.toHaveBeenCalled()
  })

  it('drains active prepares on cancellation without starting the remaining sources', async () => {
    const sources = Array.from({ length: 4 }, (_, i) => prepareSource(`@acme/cancel-${i}`))
    const held = gate(),
      reached = gate()
    const abort = new AbortController()
    let active = 0,
      started = 0,
      settled = false
    const outcome = assemble(
      await profileFor(),
      deps(allModules(), {
        signal: abort.signal,
        runtimePluginSnapshots: sources,
        runtimePrepareConcurrency: 2,
        runtimePrepareIndependent: sources.map(({ snapshot }) => snapshot),
        extensionLoader: {
          import: async () => {
            active++
            started++
            if (started === 2) reached.resolve()
            await held.promise
            active--
            return { main: () => {} }
          },
        },
      }),
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true
      })
    void outcome.then((error) => {
      if (error instanceof Error) reached.reject(error)
    })
    await reached.promise
    abort.abort()
    expect(settled).toBe(false)
    held.resolve()
    expect(await outcome).toMatchObject({ message: expect.stringContaining('aborted') })
    expect(active).toBe(0)
    expect(started).toBe(2)
  })

  it('honors cancellation during full-selection preflight before any import', async () => {
    const sources = Array.from({ length: 4 }, (_, i) => prepareSource(`@acme/preflight-cancel-${i}`))
    const abort = new AbortController()
    const imports: string[] = []
    const d = deps(allModules(), {
      signal: abort.signal,
      runtimePluginSnapshots: sources,
      runtimePrepareIndependent: sources.map(({ snapshot }) => snapshot),
      extensionLoader: {
        import: async (file) => {
          imports.push(file)
          return { main: () => {} }
        },
      },
    })
    const profile = await profileFor()
    const builtin = vi.spyOn(d.loader, 'importPackage')
    const outcome = assemble(profile, d)
    queueMicrotask(() => abort.abort())
    await expect(outcome).rejects.toThrow('aborted')
    expect(imports).toEqual([])
    expect(builtin).not.toHaveBeenCalled()
  })

  it('mounts a package trusted after boot from the installed snapshots read at apply time', async () => {
    const vendor = '@acme/late-trust'
    const snapshotDir = mkdtempSync(join(tmpdir(), 'agnes-runtime-late-trust-'))
    dirs.push(snapshotDir)
    writeFileSync(
      join(snapshotDir, 'package.json'),
      `${JSON.stringify({
        name: vendor,
        version: '1.0.0',
        exports: './index.js',
        agnes: { plugins: [{ export: 'ordinary', apiRange: '^5.0.0', id: 'ext:acme/late-trust' }] },
      })}\n`,
    )
    writeFileSync(join(snapshotDir, 'index.js'), 'export const snapshotMarker = true\n')
    const snapshot: RuntimeSnapshot = Object.freeze({
      snapshotId: `sha256-${'e'.repeat(64)}`,
      profile: 'local-dev',
      packageId: vendor,
      version: '1.0.0',
      integrity: `sha256-${'e'.repeat(64)}`,
      treeIntegrity: hashDirectory(snapshotDir, { exclude: [] }),
      capabilityHash: 'capability',
      directory: snapshotDir,
      contributions: Object.freeze([]),
    })
    const profileWith = (packages: Record<string, unknown>, extra: { id: string; source: string }[]) =>
      resolveProfile(
        {
          builtin: 'local-dev',
          lock: { packages: { ...lockPkgs, ...packages } },
          user: {
            name: 'local-dev',
            presets: { default: 'standard', allowed: ['standard'] },
            provider: { package: '@agnes/ai', routes: [ROUTE] },
            packages: extra,
          },
        },
        env,
      )
    // The rows are built the way the daemon builds them once the package is installed and trusted.
    const installedProfile = await profileWith(
      { [vendor]: { version: '1.0.0', integrity: snapshot.integrity, trust: 'trusted', enabled: true } },
      [{ id: vendor, source: 'test' }],
    )
    // The Host booted before that, so its profile does not know the package at all.
    const bootProfile = await profileWith({}, [])
    const events: string[] = []
    const ordinary = Object.assign(
      (ctx: Context) => {
        events.push('mount')
        ctx.provide('lateTrust', true)
      },
      { provide: 'lateTrust' },
    )
    for (const trusted of [true, false]) {
      events.length = 0
      const source: Readonly<RuntimePluginSnapshot> = { snapshot, generation: 1, trusted }
      const rows = await snapshotOrdinaryRows(installedProfile, source, { ordinary })
      const d = deps(allModules(), {
        runtimePluginSources: async () => [source],
        extensionLoader: { import: async () => ({ ordinary }) },
      })
      const a = await assemble(bootProfile, d)
      try {
        const applying = publishRows(a, [...a.pluginTree.currentRows(), ...rows])
        if (trusted) {
          await applying
          expect(events).toEqual(['mount'])
        } else {
          await expect(applying).rejects.toThrow(/package trust unavailable/)
          expect(events).toEqual([])
        }
      } finally {
        await closeHost(a, new Set(), { timeoutMs: 1000, audit: d.audit })
      }
    }
  })

  it('drains an admitted target apply before rollback and refuses a late one', async () => {
    const vendor = '@acme/close-race'
    const snapshotDir = mkdtempSync(join(tmpdir(), 'agnes-runtime-close-race-'))
    dirs.push(snapshotDir)
    writeFileSync(
      join(snapshotDir, 'package.json'),
      `${JSON.stringify({
        name: vendor,
        version: '1.0.0',
        exports: './index.js',
        agnes: { plugins: [{ export: 'ordinary', apiRange: '^5.0.0', id: 'ext:acme/close-race' }] },
      })}\n`,
    )
    writeFileSync(join(snapshotDir, 'index.js'), 'export const snapshotMarker = true\n')
    const snapshot: RuntimeSnapshot = Object.freeze({
      snapshotId: `sha256-${'c'.repeat(64)}`,
      profile: 'local-dev',
      packageId: vendor,
      version: '1.0.0',
      integrity: `sha256-${'d'.repeat(64)}`,
      treeIntegrity: hashDirectory(snapshotDir, { exclude: [] }),
      capabilityHash: 'capability',
      directory: snapshotDir,
      contributions: Object.freeze([]),
    })
    const bootDir = mkdtempSync(join(tmpdir(), 'agnes-runtime-close-race-boot-'))
    dirs.push(bootDir)
    writeFileSync(
      join(bootDir, 'package.json'),
      JSON.stringify({
        name: vendor,
        version: '1.0.0',
        exports: './index.js',
        agnes: { plugins: [{ export: 'boot', apiRange: '^5.0.0', id: 'ext:acme/close-race-boot' }] },
      }),
    )
    writeFileSync(join(bootDir, 'index.js'), 'export const boot = () => {}\n')
    const bootSnapshot: RuntimeSnapshot = Object.freeze({
      ...snapshot,
      snapshotId: `sha256-${'e'.repeat(64)}`,
      integrity: `sha256-${'f'.repeat(64)}`,
      treeIntegrity: hashDirectory(bootDir, { exclude: [] }),
      directory: bootDir,
    })
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        lock: {
          packages: {
            ...lockPkgs,
            [vendor]: {
              version: '1.0.0',
              integrity: snapshot.integrity,
              trust: 'trusted',
              enabled: true,
            },
          },
        },
        user: {
          name: 'local-dev',
          presets: { default: 'standard', allowed: ['standard'] },
          provider: { package: '@agnes/ai', routes: [ROUTE] },
          packages: [{ id: vendor, source: 'test' }],
        },
      },
      env,
    )
    const events: string[] = []
    let releaseLoad!: () => void
    const loadHold = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    const ordinary = Object.assign(
      (ctx: Context) => {
        events.push('mount')
        ctx.provide('closeRace', true)
        return () => events.push('unmount')
      },
      { provide: 'closeRace' },
    )
    const modules = { ...allModules(), [vendor]: { id: vendor } }
    const source: Readonly<RuntimePluginSnapshot> = { snapshot, generation: 1, trusted: true }
    const bootSource: Readonly<RuntimePluginSnapshot> = {
      snapshot: bootSnapshot,
      generation: 1,
      trusted: true,
    }
    // Built out of band from the same snapshot, so the held loader below is first entered by the
    // Host's own candidate load inside applyRuntimeTarget.
    const raceRows = await snapshotOrdinaryRows(profile, source, { ordinary })
    let bootImports = 0
    const d = deps(modules, {
      loader: new MemoryPackageLoader(modules),
      runtimePluginSnapshots: [bootSource],
      runtimePluginCatalogue: [source, bootSource],
      extensionLoader: {
        import: async () => {
          if (bootImports++ === 0) return { boot: () => {} }
          events.push('load:start')
          await loadHold
          events.push('load:end')
          return { ordinary }
        },
      },
    })
    const a = await assemble(profile, d)
    a.rollback.push('test-rollback-observer', () => {
      events.push('rollback:start')
    })

    try {
      const applying = publishRows(a, [
        ...a.pluginTree.currentRows().filter((row) => row.id !== 'ext:acme/close-race-boot'),
        ...raceRows,
      ])
      await vi.waitFor(() => expect(events).toEqual(['load:start']))
      let closeSettled = false
      const closing = closeHost(a, new Set(), { timeoutMs: 100, audit: d.audit }).then(() => {
        closeSettled = true
      })
      await Promise.resolve()
      expect(closeSettled).toBe(false)

      let lateError: unknown
      try {
        a.applyRuntimeTarget(
          buildRuntimeTarget({
            rows: [],
            resources: { mcp: [], skills: {} },
            resourceRevision: '1'.repeat(64),
            compositeRevision: '1'.repeat(64),
          }),
        )
      } catch (error) {
        lateError = error
      }
      expect(lateError).toMatchObject({ code: 'E_HOST_CLOSED' })

      releaseLoad()
      await Promise.all([applying, closing])
      expect(events).toEqual(['load:start', 'load:end', 'mount', 'rollback:start', 'unmount'])
    } finally {
      releaseLoad()
      await a.rollback.unwind()
    }
  })

  it('builds the default local workspace runtime factory with a fitted per-session seam', async () => {
    const modules = allModules()
    modules['@agnes/base'] = {
      ...modules['@agnes/base'],
      sandboxWorkspaceProbe: async () => ({
        name: 'none',
        execBackend: 'none',
        enforcement: { level: 'partial', scope: ['file'] },
        degraded: true,
        confine: ({ argv }) => argv,
      }),
    }
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agnes-asm-workspace-'))
    dirs.push(workspaceRoot)
    const d = deps(modules, { workspaceRoot })
    const assembled = await assemble(await profileFor(), d)
    const table = new SessionWorkspaceRuntimeTable()
    try {
      const binding = new WorkspaceBindingAuthority().accept(
        {
          version: 1,
          sessionKey: 'session-a',
          workspaceId: 'a'.repeat(64),
          revision: 1,
          canonicalRoot: realpathSync.native(d.workspaceRoot),
        },
        'session-a',
      )
      const runtime = await table.open(binding, () => assembled.openWorkspaceRuntime(binding))
      expect(runtime.root).toBe(realpathSync.native(d.workspaceRoot))
      expect(runtime.seam?.fsPolicy()).toBe(runtime.policy)
      expect(runtime.sandboxBackend).toEqual({ confine: expect.any(Function) })
    } finally {
      await table.closeAll()
      await assembled.rollback.unwind()
    }
  })

  it('B1 records a data-directory creation failure in startup audit', async () => {
    const p = await profileFor()
    const d = deps(allModules())
    const file = join(d.dataDir, 'not-a-directory')
    writeFileSync(file, 'x')
    await expect(assemble(p, { ...d, dataDir: file })).rejects.toMatchObject({ code: 'E_SEAM_INIT' })
    expect(events(d).some((e) => e.kind === 'startup.failed')).toBe(true)
  })

  it('B1 refuses an already cancelled assembly before loading packages', async () => {
    const p = await profileFor()
    const d = deps(allModules(), { signal: AbortSignal.abort() })
    let loaded = false
    d.loader = {
      importPackage: async (id) => {
        loaded = true
        return allModules()[id as keyof ReturnType<typeof allModules>]
      },
    }
    await expect(
      assemble(p, d).then(async (a) => {
        await a.rollback.unwind()
        return a
      }),
    ).rejects.toThrow()
    expect(loaded).toBe(false)
  })

  it('assembles the seven required seam binding rows after every registration row', async () => {
    const a = await assemble(
      await profileFor(),
      deps(allModules(), {
        pluginImporter: () => async () => undefined,
      }),
    )
    try {
      expect(a.pluginTree.bootRows.filter(({ id }) => id.startsWith('seam:')).map(({ id }) => id)).toEqual(
        SEAM_KINDS.map((name) => `seam:${name}`),
      )
      expect(a.pluginTree.bootRows.filter(({ id }) => id.startsWith('preset:')).map(({ id }) => id)).toEqual([
        'preset:base',
        'preset:standard',
      ])
      expect(a.pluginTree.root.get('preset:standard', false)).toMatchObject({ name: 'standard' })
      expect(a.pluginTree.currentRows()).toEqual(a.pluginTree.bootRows)
    } finally {
      await a.rollback.unwind()
    }
  })

  it('updates a required seam in place, invalidates sessions, and fails closed while it is absent', async () => {
    const module = baseModule()
    const original = fakeSeams().approval
    const actor: Actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
    const authorize = vi.fn(async () => ({
      decisionId: 'allow-before-removal',
      effect: 'allow' as const,
      reason: 'test',
    }))
    const seams = testSeams(module)
    seams.approval = async (ctx) => ({
      ...original,
      ask: async () =>
        ctx.profile.preset.marker === 'updated' ? ('rejected' as const) : ('allowed-once' as const),
    })
    const originalPrincipals = fakeSeams().principals
    seams.principals = async () => ({ ...originalPrincipals, authorize })
    const profile = await profileFor()
    const assemblyDeps = deps({ '@agnes/base': module, '@agnes/code': codeModule, '@agnes/ai': aiModule })
    // The Kernel opens a session on the unbound static seam here, so it must answer for the workspace.
    assemblyDeps.sandboxSeam = {
      ...fakeSeams().sandbox,
      fsPolicy: () => testFsPolicy(realpathSync.native(assemblyDeps.workspaceRoot)),
    }
    const a = await assemble(profile, assemblyDeps)
    try {
      const stable = a.seams.approval
      const invalidate = vi.spyOn(a.kernel, 'invalidateSeams')
      expect(await stable.ask({} as never)).toBe('allowed-once')
      const session = await a.kernel.session('seam-cache-invalidation', {
        actor,
        resolvedProfileHash: profile.hash,
        cwd: assemblyDeps.workspaceRoot,
        writerRunId: 'seam-cache-invalidation-writer',
      })
      const target = { kind: 'skill' as const, id: 'cached-before-removal' }
      await expect(session.d.runtime.authorize(actor, 'execute', target)).resolves.toMatchObject({
        effect: 'allow',
      })
      await expect(session.d.runtime.authorize(actor, 'execute', target)).resolves.toMatchObject({
        effect: 'allow',
      })
      expect(authorize).toHaveBeenCalledOnce()

      const updatedRows = a.pluginTree.currentRows().map((row) =>
        row.id === 'seam:approval'
          ? Object.freeze({
              ...row,
              config: Object.freeze({ ...(row.config as Record<string, unknown>), marker: 'updated' }),
            })
          : row,
      )
      await expect(publishRows(a, updatedRows)).rejects.toThrow(/builtin claim seam:approval/)
      expect(a.seams.approval).toBe(stable)
      expect(await stable.ask({} as never)).toBe('allowed-once')
      expect(invalidate).not.toHaveBeenCalled()

      const missingApproval = updatedRows.filter(
        (row) => row.id !== 'seam:approval' && row.id !== 'seam:principals',
      )
      // Host-static seam rows cannot be deleted by a partial desired update; the complete target
      // preserves the required rows and therefore never exposes a transient unavailable seam.
      await expect(publishRows(a, missingApproval)).resolves.toMatchObject({ ok: true })
      expect(await stable.ask({} as never)).toBe('allowed-once')
      expect(invalidate).not.toHaveBeenCalled()
      expect(authorize).toHaveBeenCalledOnce()

      await expect(publishRows(a, updatedRows)).rejects.toThrow(/builtin claim seam:approval/)
      expect(await stable.ask({} as never)).toBe('allowed-once')
      expect(invalidate).not.toHaveBeenCalled()
    } finally {
      await a.rollback.unwind()
    }
  })

  it('publishes preset data as an ordinary row and updates it without replacing the tree', async () => {
    const a = await assemble(await profileFor(), deps(allModules()))
    try {
      const rows = a.pluginTree.currentRows().map((row) =>
        row.id === 'preset:standard'
          ? Object.freeze({
              ...row,
              config: Object.freeze({ ...(row.config as Record<string, unknown>), marker: 'updated' }),
            })
          : row,
      )
      await expect(publishRows(a, rows)).rejects.toThrow(/builtin claim preset:standard/)
      expect(a.pluginTree.root.get('preset:standard', false)).toMatchObject({ name: 'standard' })
    } finally {
      await a.rollback.unwind()
    }
  })

  it('does not execute an enabled managed package that is absent from the selected snapshot set', async () => {
    const vendor = '@acme/managed-but-unselected'
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        lock: {
          packages: {
            ...lockPkgs,
            [vendor]: { version: '1.0.0', integrity: 'sha512-vendor', trust: 'trusted', enabled: true },
          },
        },
        user: {
          name: 'local-dev',
          presets: { default: 'standard', allowed: ['standard'] },
          provider: { package: '@agnes/ai', routes: [ROUTE] },
          packages: [{ id: vendor, source: 'test' }],
        },
      },
      env,
    )
    const loader = new MemoryPackageLoader({
      ...allModules(),
      [vendor]: { id: vendor, presets: { unexpected: { name: 'unexpected' } } },
    })
    const imported = vi.spyOn(loader, 'importPackage')
    await expect(
      assemble(profile, deps(allModules(), { loader, managedExtensionPackageIds: [vendor] })),
    ).rejects.toMatchObject({ code: 'E_EXT_LOAD', detail: { reason: 'snapshot-unavailable' } })
    expect(imported).not.toHaveBeenCalledWith(vendor, expect.any(String))
  })

  it('loads a generic plugin from an immutable runtime snapshot and applies layered hot updates', async () => {
    const vendor = '@acme/greeting'
    const snapshotDir = mkdtempSync(join(tmpdir(), 'agnes-runtime-plugin-'))
    dirs.push(snapshotDir)
    writeFileSync(
      join(snapshotDir, 'package.json'),
      `${JSON.stringify({
        name: vendor,
        version: '1.0.0',
        exports: './index.js',
        agnes: {
          plugins: [
            {
              export: 'greeting',
              apiRange: '^5.0.0',
              id: 'ext:acme/greeting',
              config: { message: 'bundle' },
            },
          ],
        },
      })}\n`,
    )
    writeFileSync(join(snapshotDir, 'index.js'), 'export const snapshotMarker = true\n')
    const snapshot: RuntimeSnapshot = Object.freeze({
      snapshotId: `sha256-${'1'.repeat(64)}`,
      profile: 'local-dev',
      packageId: vendor,
      version: '1.0.0',
      integrity: `sha256-${'2'.repeat(64)}`,
      treeIntegrity: hashDirectory(snapshotDir, { exclude: [] }),
      capabilityHash: 'capability',
      directory: snapshotDir,
      contributions: Object.freeze([]),
    })
    const applied: string[] = []
    const runtimePreset = { name: 'runtime-demo', marker: 'v1' }
    const runtimePresetV2 = { name: 'runtime-demo', marker: 'v2' }
    const runtimeAddedPresetV2 = { name: 'runtime-added', marker: 'v2' }
    const greeting = Object.assign(
      (ctx: Context, config: { message: string }) => {
        applied.push(config.message)
        return ctx.provide('demoGreeting', config.message)
      },
      {
        provide: 'demoGreeting',
        Config: {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate(value: unknown) {
              return value && typeof (value as { message?: unknown }).message === 'string'
                ? { value: value as { message: string } }
                : { issues: [{ message: 'message is required' }] }
            },
          },
        },
      },
    )
    const snapshotDirV2 = mkdtempSync(join(tmpdir(), 'agnes-runtime-plugin-v2-'))
    dirs.push(snapshotDirV2)
    writeFileSync(join(snapshotDirV2, 'package.json'), readFileSync(join(snapshotDir, 'package.json')))
    writeFileSync(join(snapshotDirV2, 'index.js'), 'export const snapshotMarker = "v2"\n')
    const snapshotV2: RuntimeSnapshot = Object.freeze({
      ...snapshot,
      snapshotId: `sha256-${'3'.repeat(64)}`,
      integrity: `sha256-${'4'.repeat(64)}`,
      treeIntegrity: hashDirectory(snapshotDirV2, { exclude: [] }),
      directory: snapshotDirV2,
    })
    let rejectV2Mount = false
    const greetingV2 = Object.assign(
      (ctx: Context, config: { message: string }) => {
        if (rejectV2Mount) throw new Error('injected-v2-mount-failure')
        applied.push(`v2:${config.message}`)
        return ctx.provide('demoGreeting', `v2:${config.message}`)
      },
      { provide: 'demoGreeting', Config: greeting.Config },
    )
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        lock: {
          packages: {
            ...lockPkgs,
            [vendor]: {
              version: '1.0.0',
              integrity: snapshot.integrity,
              trust: 'trusted',
              enabled: true,
            },
          },
        },
        user: {
          name: 'local-dev',
          presets: { default: 'standard', allowed: ['standard'] },
          provider: { package: '@agnes/ai', routes: [ROUTE] },
          packages: [{ id: vendor, source: 'test' }],
        },
      },
      env,
    )
    const layers = {
      deployment: { 'ext:acme/greeting': { config: { message: 'deployment' } } },
      user: { 'ext:acme/greeting': { config: { message: 'user' } } },
      workspace: { 'ext:acme/greeting': { config: { message: 'workspace' } } },
    }
    const v1Source: Readonly<RuntimePluginSnapshot> = { snapshot, generation: 9, trusted: true }
    const v2Source: Readonly<RuntimePluginSnapshot> = {
      snapshot: snapshotV2,
      generation: 9,
      trusted: true,
    }
    const a = await assemble(
      profile,
      deps(allModules(), {
        extensionLoader: {
          import: vi.fn(async (file) =>
            file.includes('agnes-runtime-plugin-v2-')
              ? {
                  greeting: greetingV2,
                  presets: { 'runtime-demo': runtimePresetV2, 'runtime-added': runtimeAddedPresetV2 },
                }
              : { greeting, presets: { 'runtime-demo': runtimePreset } },
          ),
        },
        runtimePluginSnapshots: [v1Source],
        runtimePluginCatalogue: [v1Source, v2Source],
        ordinaryPluginLayers: layers,
      }),
    )
    const v1Rows = await snapshotOrdinaryRows(
      profile,
      v1Source,
      { greeting, presets: { 'runtime-demo': runtimePreset } },
      layers,
    )
    const v2Rows = await snapshotOrdinaryRows(
      profile,
      v2Source,
      {
        greeting: greetingV2,
        presets: { 'runtime-demo': runtimePresetV2, 'runtime-added': runtimeAddedPresetV2 },
      },
      layers,
    )
    try {
      expect(a.pluginTree.root.get('demoGreeting', false)).toBe('workspace')
      expect(a.pluginTree.root.get('preset:runtime-demo', false)).toMatchObject({ marker: 'v1' })
      expect(applied).toEqual(['workspace'])
      const updated = a.pluginTree
        .currentRows()
        .map((row) =>
          row.id === 'ext:acme/greeting'
            ? Object.freeze({ ...row, config: Object.freeze({ message: 'updated' }) })
            : row,
        )
      await publishRows(a, updated)
      expect(a.pluginTree.root.get('demoGreeting', false)).toBe('updated')
      expect(applied).toEqual(['workspace', 'updated'])

      await publishRows(
        a,
        updated.filter((row) => row.id !== 'ext:acme/greeting'),
      )
      expect(a.pluginTree.root.get('demoGreeting', false)).toBeUndefined()

      await publishRows(a, updated)
      expect(a.pluginTree.root.get('demoGreeting', false)).toBe('updated')
      expect(applied).toEqual(['workspace', 'updated', 'updated'])

      const withoutGreeting = () => a.pluginTree.currentRows().filter((row) => row.id !== 'ext:acme/greeting')

      rejectV2Mount = true
      await expect(publishRows(a, [...withoutGreeting(), ...v2Rows])).rejects.toThrow(
        'injected-v2-mount-failure',
      )
      expect(a.pluginTree.root.get('demoGreeting', false)).toBe('updated')

      rejectV2Mount = false
      await publishRows(a, [...withoutGreeting(), ...v2Rows])
      expect(a.pluginTree.root.get('demoGreeting', false)).toBe('v2:workspace')
      // The preset catalogue is Host-static: a target selecting the V2 snapshot swaps the ordinary
      // plugin row but never re-derives `preset:` rows, so V1's preset stays live and the preset
      // the V2 snapshot adds never appears. Changing the assembled preset catalogue is a restart.
      expect(a.pluginTree.root.get('preset:runtime-demo', false)).toMatchObject({ marker: 'v1' })
      expect(a.pluginTree.root.get('preset:runtime-added', false)).toBeUndefined()

      await publishRows(a, withoutGreeting())
      expect(a.pluginTree.root.get('demoGreeting', false)).toBeUndefined()
      await publishRows(a, [...withoutGreeting(), ...v1Rows])
      expect(a.pluginTree.root.get('demoGreeting', false)).toBe('workspace')
    } finally {
      await a.rollback.unwind()
    }
  })

  it('refuses a target that rewrites the runtime-owned default preset and keeps V1 live', async () => {
    const vendor = '@acme/runtime-default-preset'
    const directory = mkdtempSync(join(tmpdir(), 'agnes-runtime-default-preset-'))
    dirs.push(directory)
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({
        name: vendor,
        version: '1.0.0',
        exports: './index.js',
        agnes: { plugins: [{ export: 'ordinary', apiRange: '^5.0.0', id: 'ext:acme/default-owner' }] },
      })}\n`,
    )
    writeFileSync(join(directory, 'index.js'), 'export const marker = true\n')
    const snapshot: RuntimeSnapshot = Object.freeze({
      snapshotId: `sha256-${'e'.repeat(64)}`,
      profile: 'local-dev',
      packageId: vendor,
      version: '1.0.0',
      integrity: `sha256-${'f'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'capability',
      directory,
      contributions: Object.freeze([]),
    })
    const ordinary = Object.assign(() => {}, { provide: 'default-owner' })
    const profile = await resolveProfile(
      {
        builtin: 'local-dev',
        lock: {
          packages: {
            ...lockPkgs,
            [vendor]: { version: '1.0.0', integrity: snapshot.integrity, trust: 'trusted', enabled: true },
          },
        },
        user: {
          name: 'local-dev',
          provider: { package: '@agnes/ai', routes: [ROUTE] },
          packages: [{ id: vendor, source: 'test' }],
          presets: { default: 'runtime-default', allowed: ['runtime-default'] },
        },
      },
      env,
    )
    const a = await assemble(
      profile,
      deps(allModules(), {
        runtimePluginSnapshots: [{ snapshot, generation: 6, trusted: true }],
        extensionLoader: {
          import: async () => ({
            ordinary,
            presets: {
              'runtime-default': { name: 'runtime-default', extends: 'base', disclosure: 'standard' },
            },
          }),
        },
      }),
    )
    try {
      expect(a.pluginTree.root.get('preset:runtime-default', false)).toMatchObject({
        name: 'runtime-default',
      })
      // A target that drops the preset row cannot unpublish the active default: the Host-static boot
      // rows carry it, so the empty desired set leaves V1 mounted.
      await expect(
        publishRows(
          a,
          a.pluginTree.currentRows().filter((row) => row.id !== 'preset:runtime-default'),
        ),
      ).resolves.toMatchObject({ ok: true })
      expect(a.pluginTree.root.get('preset:runtime-default', false)).toMatchObject({
        name: 'runtime-default',
      })
      // A target that rewrites it into an unresolvable document is refused by the Host-private
      // builtin claim, before any mount, and V1 stays live.
      await expect(
        publishRows(
          a,
          a.pluginTree.currentRows().map((row) =>
            row.id === 'preset:runtime-default'
              ? Object.freeze({
                  ...row,
                  config: Object.freeze({ name: 'runtime-default', extends: 'missing' }),
                })
              : row,
          ),
        ),
      ).rejects.toThrow(/builtin claim preset:runtime-default/)
      expect(a.pluginTree.root.get('preset:runtime-default', false)).toMatchObject({
        name: 'runtime-default',
      })
    } finally {
      await a.rollback.unwind()
    }
  })

  it('normalizes each runtime plugin export once while building its verified row claim', async () => {
    const vendor = '@acme/metadata-once'
    const directory = mkdtempSync(join(tmpdir(), 'agnes-runtime-plugin-once-'))
    dirs.push(directory)
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({
        name: vendor,
        version: '1.0.0',
        exports: './index.js',
        agnes: { plugins: [{ export: 'ordinary', apiRange: '^5.0.0' }] },
      })}\n`,
    )
    writeFileSync(join(directory, 'index.js'), 'export const marker = true\n')
    const snapshot: RuntimeSnapshot = Object.freeze({
      snapshotId: `sha256-${'5'.repeat(64)}`,
      profile: 'local-dev',
      packageId: vendor,
      version: '1.0.0',
      integrity: `sha256-${'6'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'capability',
      directory,
      contributions: Object.freeze([]),
    })
    let reads = 0
    const ordinary = Object.assign(() => {}, { provide: 'metadata-once' })
    const namespace: Record<string, unknown> = {}
    Object.defineProperty(namespace, 'ordinary', {
      enumerable: true,
      get() {
        reads += 1
        return ordinary
      },
    })

    const loaded = await loadRuntimePackage(
      { snapshot, generation: 3, trusted: true },
      { import: async () => namespace },
    )

    expect(loaded?.module.plugins).toHaveLength(1)
    expect(reads).toBe(1)
  })

  it('rejects a non-builtin transport without an immutable runtime snapshot before loading it', async () => {
    const vendor = '@acme/fake-vendor'
    const m = allModules() as Record<string, PackageModule>
    const d = deps(m)
    // This fixture uses the local filesystem as its fake remote volume. Keep the advertised
    // remote spelling aligned with that volume's canonical root (not macOS's /var alias), so the
    // remote symlink walk and policy describe the same workspace.
    d.dataDir = realpathSync.native(d.dataDir)
    d.homeDir = realpathSync.native(d.homeDir ?? d.dataDir)
    d.workspaceRoot = realpathSync.native(d.workspaceRoot)
    const order: string[] = []
    const uploaded: string[] = []
    let opened = true
    const t: RemoteTransport = {
      alive: () => opened,
      close: async () => {
        opened = false
      },
      upload: async (files) => {
        for (const f of files) {
          uploaded.push(f.path)
          await localFsIo.writeFile(f.path, f.content)
        }
      },
      download: async (paths) =>
        Promise.all(paths.map(async (path) => ({ path, content: await localFsIo.readFile(path) }))),
      exec: async (cmd) => {
        let stdout = ''
        // This test vendor answers the retained Python protocol without requiring a local shell.
        if (cmd[0] === 'python3') {
          const script = cmd[2] ?? ''
          const path = cmd[3] ?? ''
          if (script.includes('os.lstat(p)')) {
            const st = await localFsIo.lstat(path)
            stdout = st ? `${st.kind}\n${st.size}\n${st.mtimeMs}\n` : 'none\n'
          } else if (script.includes('os.makedirs')) await localFsIo.mkdir(path)
          else throw new Error('unexpected remote script')
        } else if (cmd[0] === 'vendor-command') stdout = 'vendor-result'
        else if (cmd[0] !== 'mkdir' && cmd[0] !== 'rm') throw new Error('unexpected remote command')
        return { code: 0, stdout, stderr: '', truncated: false }
      },
    }
    m[vendor] = {
      id: vendor,
      sandboxProvider: defineRemoteSandboxProvider({
        id: 'vendor-remote',
        version: '1.0.0',
        openTransport: async (config, ctx) => {
          order.push('open')
          expect(order.slice(0, -1).sort()).toEqual(Object.keys(m).sort())
          expect(config.opaque).toEqual({ value: 42 })
          expect(typeof ctx.secret).toBe('function')
          expect(ctx.signal).toBeInstanceOf(AbortSignal)
          return t
        },
      }),
    }
    d.loader = {
      importPackage: async (id) => {
        order.push(id)
        const mod = m[id]
        if (!mod) throw new Error('missing fixture package')
        return mod
      },
    }
    const p = await resolveProfile(
      {
        builtin: 'local-dev',
        lock: {
          packages: {
            ...lockPkgs,
            [vendor]: { version: '1', integrity: 'test', trust: 'trusted', enabled: true },
          },
        },
        user: {
          name: 'p',
          provider: { package: '@agnes/ai', routes: [ROUTE] },
          providers: { sandbox: { provider: 'vendor-remote' } },
          packages: [
            {
              id: vendor,
              source: 'test',
              config: {
                rootTemplate: '/vendor/sessions/{session}',
                opaque: { value: 42 },
              },
            },
          ],
        },
      },
      env,
    )
    await expect(assemble(p, d)).rejects.toMatchObject({
      code: 'E_EXT_LOAD',
      detail: { package: vendor, reason: 'snapshot-unavailable' },
    })
    expect(order).toEqual([])
  })

  it('assembles a kernel with nine seams, provider, presets and the resolved default preset', async () => {
    const p = await profileFor()
    const a = await assemble(p, deps(allModules()))
    expect(Object.keys(a.seams).sort()).toEqual([
      'approval',
      'artifacts',
      'billing',
      'checkpoint',
      'platform',
      'principals',
      'repair',
      'sandbox',
      'verifier',
    ])
    expect(a.defaultPreset.view.name).toBe('standard')
    expect(a.presets.standard).toBeDefined()
    expect(a.routes?.primary).toEqual({ route: 'gw', model: 'm1' })
    expect(typeof a.kernel.session).toBe('function')
    expect(a.lockedPackageMutations.status()).toEqual({
      activationReady: false,
      recoveryReady: false,
      blockers: [
        'store-directory-unavailable',
        'mutation-engine-unavailable',
        'environment-unavailable',
        'publisher-keyring-unavailable',
        'safe-extraction-unavailable',
        'trusted-directory-handle-unavailable',
      ],
    })
    await a.rollback.unwind()
    expect(() => a.lockedPackageMutations.session('after-close')).toThrow(/runtime is closed/)
  })
  it('passes an explicitly trusted request-media runtime into the single assembled Kernel', async () => {
    const requestMedia = {
      readArtifact: async () => undefined,
      surfaceLimits: {
        maxLedgerEvents: 32,
        maxSurfaceNodes: 32,
        maxContentBlocks: 64,
        maxManifestEntries: 8,
        maxCandidateBytes: 4096,
        maxCandidatePixels: 4096,
      },
      mediaLimits: {
        maxManifestEntries: 8,
        maxSelectedImages: 3,
        maxSelectedBlocks: 8,
        maxBytesPerImage: 4096,
        maxDimensionPerImage: 1456,
        maxPixelsPerImage: 4096,
        maxSelectedBytes: 8192,
        maxSelectedPixels: 8192,
      },
    } satisfies NonNullable<AssembleDeps['requestMedia']>
    const a = await assemble(await profileFor(), deps(allModules(), { requestMedia }))

    expect(a.kernel.o.requestMedia).toBe(requestMedia)
    expect(a.kernel.o.imageInputTokenFallback).toEqual(expect.any(Function))
    await a.rollback.unwind()
  })
  it('does not synthesize request-media limits or auxiliary admission when Host omits the port', async () => {
    const a = await assemble(await profileFor(), deps(allModules()))

    expect(Object.hasOwn(a.kernel.o, 'requestMedia')).toBe(false)
    expect(a.kernel.o.requestMedia).toBeUndefined()
    expect(a.kernel.o.imageInputTokenFallback).toBeUndefined()
    await a.rollback.unwind()
  })
  it('the view the kernel runs on carries the resolved route and model, not the sentinel', async () => {
    const p = await profileFor()
    const a = await assemble(p, deps(allModules()))
    expect(a.defaultPreset.view.model.route).toEqual({ primary: 'gw' })
    expect(a.defaultPreset.view.model.id).toEqual({ primary: 'm1' })
    await a.rollback.unwind()
  })
  it('applies the profile consent overlay to the preset assembled for real sessions', async () => {
    const p = await profileFor()
    const d = deps(allModules())
    mkdirSync(d.profileDir, { recursive: true })
    writeFileSync(join(d.profileDir, 'consent.yaml'), 'telemetry:\n  consent: ANON\n')
    const a = await assemble(p, d)
    expect(a.presets.standard?.telemetry).toMatchObject({ consent: 'ANON' })
    await a.rollback.unwind()
  })
  it('keeps the profile consent out of permission overlays, so a profile that gave consent still assembles', async () => {
    const p = await profileFor()
    const code: PackageModule = {
      ...codeModule,
      presets: {
        ...codeModule.presets,
        'permission-workspace-write': { name: 'permission-workspace-write', sandbox: { level: 'L1' } },
      },
    }
    const d = deps({ '@agnes/base': baseModule(), '@agnes/code': code, '@agnes/ai': aiModule })
    mkdirSync(d.profileDir, { recursive: true })
    writeFileSync(join(d.profileDir, 'consent.yaml'), 'telemetry:\n  consent: LOCAL\n')
    const a = await assemble(p, d)
    expect(a.presets['permission-workspace-write']).not.toHaveProperty('telemetry')
    expect(a.presets.standard?.telemetry).toMatchObject({ consent: 'LOCAL' })
    expect(a.defaultPreset.hash).toMatch(/^sha256-/)
    await a.rollback.unwind()
  })
  it('gives each seam a context bound to its own package and the seven profile fields base reads', async () => {
    const p = await profileFor()
    const seen: Array<Record<string, unknown>> = []
    const m = baseModule()
    const seams = testSeams(m)
    seams.approval = async (ctx) => {
      seen.push(ctx.profile)
      return { ask: async () => 'allowed-once', resume: async () => null }
    }
    const a = await assemble(p, deps({ '@agnes/base': m, '@agnes/code': codeModule, '@agnes/ai': aiModule }))
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
      'dataDir',
      'homeDir',
      'limits',
      'name',
      'preset',
      'resolvedProfileHash',
      'workspaceRoot',
    ])
    const ctx = seen[0] ?? {}
    expect(ctx.resolvedProfileHash).toBe(p.hash)
    expect((ctx.preset as { name: string }).name).toBe('standard')
    await a.rollback.unwind()
  })
  it('keeps screenshot collection off while permitting private shared CAS writes', async () => {
    const p = await profileFor({ computerUse: { enabled: false } })
    const m = baseModule()
    const seams = testSeams(m)
    const originalArtifacts = seams.artifacts
    if (!originalArtifacts) throw new Error('missing fixture artifacts seam')
    let privateStoreInjected = false
    seams.artifacts = async (ctx) => {
      privateStoreInjected = ctx.privateArtifactStore !== undefined
      return originalArtifacts(ctx)
    }

    const a = await assemble(p, deps({ '@agnes/base': m, '@agnes/code': codeModule, '@agnes/ai': aiModule }))
    expect(privateStoreInjected).toBe(privateArtifactDeleteAvailable())
    expect(a.computerUseArtifactGc).toBeUndefined()
    await a.rollback.unwind()
  })
  it('binds a selected seam provider that another package registers through the same path as base', async () => {
    const snapshots: string[] = []
    const alt = {
      id: 'alt',
      version: '1.0.0',
      create: async () => ({
        snapshot: async (paths: string[]) => {
          snapshots.push(...paths)
          return { id: 'alt-1' }
        },
        rewind: async () => undefined,
        list: async () => [],
      }),
    }
    const vendor: PackageModule = {
      id: '@agnes/code',
      presets: codeModule.presets as never,
      operations: {},
      plugins: [
        {
          declaration: {
            export: 'altCheckpointPlugin',
            apiRange: '^5.0.0',
            id: 'seam-providers:alt',
            inject: ['providers'],
            runtime: 'in-process',
            default: true,
          },
          entry: normalizePluginExport({
            inject: ['providers'],
            apply: (ctx: ProviderPluginContext) => {
              ctx.providers.register(checkpointKind, alt as never)
            },
          } as never),
        },
      ],
    }
    const profile = await profileFor({ providers: { checkpoint: { provider: 'alt' } } })
    const a = await assemble(
      profile,
      deps({ '@agnes/base': baseModule(), '@agnes/code': vendor, '@agnes/ai': aiModule }),
    )
    try {
      expect(await a.seams.checkpoint.snapshot(['x.txt'], '1/1')).toEqual({ id: 'alt-1' })
      expect(snapshots).toEqual(['x.txt'])
      const rows = a.pluginTree.currentRows().map(({ id }) => id)
      expect(rows.indexOf('seam:checkpoint')).toBeGreaterThan(rows.indexOf('seam-providers:alt'))
      const entry = a.pluginTree.root.providers
        .catalog()
        .find((e) => e.kind === 'checkpoint' && e.id === 'alt')
      expect(entry).toMatchObject({
        sourcePackage: '@agnes/code',
        required: true,
        pinned: true,
        active: true,
      })
    } finally {
      await a.rollback.unwind()
    }
  })

  it('an unregistered selected provider is E_SEAM_MISSING; a rejecting factory is E_SEAM_INIT; both roll back', async () => {
    const p = await profileFor()
    const noApproval = baseModule()
    delete testSeams(noApproval).approval
    await expect(
      assemble(p, deps({ '@agnes/base': noApproval, '@agnes/code': codeModule, '@agnes/ai': aiModule })),
    ).rejects.toThrow(/E_SEAM_MISSING.*approval/)
    const bad = baseModule()
    testSeams(bad).billing = async () => {
      throw new Error('db down')
    }
    const d = deps({ '@agnes/base': bad, '@agnes/code': codeModule, '@agnes/ai': aiModule })
    await expect(assemble(p, d)).rejects.toThrow(/E_SEAM_INIT.*billing/)
    expect(events(d).at(-1)).toMatchObject({ kind: 'startup.failed', detail: { step: 'seams' } })
  })
  it('reports the first seam in SEAM_NAMES order when two fail, not whichever rejected soonest', async () => {
    const p = await profileFor()
    const m = baseModule()
    const seams = testSeams(m)
    // repair comes after checkpoint in SEAM_NAMES, and rejects first in wall-clock time.
    seams.repair = async () => {
      throw new Error('immediate')
    }
    seams.checkpoint = async () => {
      await new Promise((r) => setTimeout(r, 20))
      throw new Error('later')
    }
    await expect(
      assemble(p, deps({ '@agnes/base': m, '@agnes/code': codeModule, '@agnes/ai': aiModule })),
    ).rejects.toThrow(/checkpoint/)
  })
  it('refuses a profile whose presets.allowed names a recipe no package provides', async () => {
    const p = await profileFor({ presets: { default: 'standard', allowed: ['standard', 'claw'] } })
    await expect(assemble(p, deps(allModules()))).rejects.toThrow(/E_PRESET_UNSUPPORTED.*claw/)
  })
  it('refuses a seam package that is not among the loaded modules', async () => {
    const p = await profileFor()
    await expect(assemble(p, deps({ '@agnes/code': codeModule, '@agnes/ai': aiModule }))).rejects.toThrow(
      /E_DEP_MISSING/,
    )
  })
  it.each(ASSEMBLY_STEPS)(
    'crash injection at %s refuses with that step and never reports ready',
    async (step) => {
      const p = await profileFor()
      const d = deps(allModules(), { crashAt: step })
      await expect(assemble(p, d)).rejects.toThrow(`crash:${step}`)
      expect(events(d).at(-1), step).toMatchObject({ kind: 'startup.failed', detail: { step } })
      expect(
        events(d).some((e) => e.kind === 'host.ready'),
        step,
      ).toBe(false)
    },
  )
  // The claim the crash matrix above does NOT make on its own: that a failed assembly tears down
  // what it had already brought up. Asserting the audit event only proves the failure was recorded,
  // so the teardown is observed directly - a seam close() that runs, and one that throws and is
  // reported by label rather than swallowed.
  it('a crash after the seams tears them down, and a failing teardown is named not swallowed', async () => {
    const p = await profileFor()
    const closed: string[] = []
    const real = fakeSeams()
    const m = baseModule()
    const seams = testSeams(m)
    seams.verifier = async () => ({
      ...real.verifier,
      close: () => {
        closed.push('verifier')
        throw new Error('teardown refused')
      },
    })
    seams.repair = async () => ({
      ...real.repair,
      close: () => {
        closed.push('repair')
      },
    })
    const d = deps(
      { '@agnes/base': m, '@agnes/code': codeModule, '@agnes/ai': aiModule },
      { crashAt: 'provider' },
    )
    await expect(assemble(p, d)).rejects.toThrow('crash:provider')
    expect(closed.sort()).toEqual(['repair', 'verifier'])
    // Cordis owns plugin cleanup and reports disposer failures through its logger while continuing
    // to tear down sibling rows. The Host rollback therefore completes instead of retaining the
    // legacy per-seam rollback label.
    expect(events(d).at(-1)?.detail?.rollbackFailed).toEqual([])
  })
  it('keeps a retired package format actionable while unwinding Host assembly', async () => {
    const p = await profileFor()
    const d = deps(allModules(), {
      providerFactory: () => {
        assertCurrentPackageFormat({ metadata: { category: 'private-log' } })
        return new ScriptedProvider({ scripts: [] })
      },
    })
    await expect(assemble(p, d)).rejects.toMatchObject({
      code: 'E_PACKAGE_INTEGRITY',
      detail: { reason: 'clean-home-required' },
    })
    expect(events(d).at(-1)?.detail?.rollbackFailed).toEqual([])
  })
  it('seam factory timeout is E_SEAM_INIT with reason timeout', async () => {
    const p = await profileFor()
    const slow = baseModule()
    testSeams(slow).verifier = () => new Promise(() => {})
    await expect(
      assemble(
        p,
        deps(
          { '@agnes/base': slow, '@agnes/code': codeModule, '@agnes/ai': aiModule },
          { seamTimeoutMs: 50 },
        ),
      ),
    ).rejects.toThrow(/E_SEAM_INIT.*timed out/)
  })
  it('a seam that hands back something that is not an object is refused, not fitted', async () => {
    const p = await profileFor()
    const m = baseModule()
    testSeams(m).verifier = async () => 'not a seam' as never
    await expect(
      assemble(p, deps({ '@agnes/base': m, '@agnes/code': codeModule, '@agnes/ai': aiModule })),
    ).rejects.toThrow(/E_SEAM_INIT.*non-object/)
  })
  it('a seam with a close() is torn down by the rollback, once', async () => {
    const p = await profileFor()
    let closed = 0
    const m = baseModule()
    const seams = testSeams(m)
    const real = fakeSeams()
    seams.verifier = async () => ({
      ...real.verifier,
      close: () => {
        closed++
      },
    })
    const a = await assemble(p, deps({ '@agnes/base': m, '@agnes/code': codeModule, '@agnes/ai': aiModule }))
    await a.rollback.unwind()
    await a.rollback.unwind()
    expect(closed).toBe(1)
  })
  it('sweeps the AWS destination environment before a credential is bound', async () => {
    const p = await profileFor()
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'https://attacker.example',
    }
    // The ordering claim is observed where it happens, not in the audit trail: both log lines sit
    // beside the code they describe, so an assertion on their indices moves with the bug. The
    // factory reads the environment at the moment the provider is built - the moment a credential
    // is bound - and that is the only reading that says anything about the order.
    let atBuild: NodeJS.ProcessEnv = {}
    const d = deps(allModules(), {
      env: e,
      providerFactory: () => {
        atBuild = { ...e }
        return new ScriptedProvider({ scripts: [] })
      },
    })
    const a = await assemble(p, d)
    expect(atBuild.AWS_ENDPOINT_URL_BEDROCK_RUNTIME).toBeUndefined()
    expect(atBuild.AWS_REGION).toBeUndefined()
    expect(atBuild.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS).toBe('true')
    expect(e.AWS_ENDPOINT_URL_BEDROCK_RUNTIME).toBeUndefined()
    expect(e.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS).toBe('true')
    const swept = events(d).find((x) => x.kind === 'provider.env_swept')
    expect(swept?.detail?.removed).toContain('AWS_ENDPOINT_URL_BEDROCK_RUNTIME')
    await a.rollback.unwind()
  })
  it('refuses two packages contributing a preset of the same name', async () => {
    const p = await profileFor()
    const second: PackageModule = { id: '@agnes/code', presets: { base: { name: 'base' } }, operations: {} }
    const e = await assemble(
      p,
      deps({ '@agnes/base': baseModule(), '@agnes/code': second, '@agnes/ai': aiModule }),
    ).then(
      () => {
        throw new Error('expected a refusal')
      },
      (x: unknown) => x as { code: string; detail: Record<string, unknown> },
    )
    // Last-writer-wins made this whichever package profile.packages happened to list second.
    expect(e.code).toBe('E_PACKAGE_DUPLICATE')
    expect(e.detail.source).toBe('base')
  })
  it('refuses two packages contributing a runtime of the same language', async () => {
    const p = await profileFor()
    const rt = { python: async () => ({}) }
    const e = await assemble(
      p,
      deps({
        '@agnes/base': baseModule({ runtimes: rt }),
        '@agnes/code': { ...codeModule, runtimes: rt },
        '@agnes/ai': aiModule,
      }),
    ).then(
      () => {
        throw new Error('expected a refusal')
      },
      (x: unknown) => x as { code: string; detail: Record<string, unknown> },
    )
    expect(e.code).toBe('E_PACKAGE_DUPLICATE')
    expect(e.detail.source).toBe('python')
  })
  it('assembles applyRuntimeTarget with all account credentials missing and refuses inference clearly', async () => {
    const d = deps(allModules())
    const configuration = createConfigurationService({
      home: join(d.dataDir, 'home'),
      profile: 'local-dev',
      request: async () =>
        new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }), {
          headers: { 'content-type': 'application/json' },
        }),
    })
    await configuration.save({
      accountId: 'lost',
      providerId: 'deepseek',
      model: 'deepseek-flash',
      apiKey: 'test-lost-key',
    })
    const before = await configuration.profileInput()
    const ref = before.provider?.routes?.[0]?.credentialRef
    if (!ref) throw new Error('missing credential reference')
    await createCredentialStore({ root: join(d.dataDir, 'home') }).remove(ref)
    const overlay = await configuration.profileInput()
    expect(overlay.provider?.routes).toEqual([])
    const p = await resolveProfile(
      {
        builtin: 'local-dev',
        user: { name: 'local-dev', ...overlay, presets: { default: 'standard', allowed: ['standard'] } },
      },
      env,
    )
    delete d.providerFactory
    d.allowUnresolvedProvider = true
    const a = await assemble(p, d)
    expect(a.provider.models()).toEqual([])
    await expect(
      a.provider
        .infer(fakeRequest(), { signal: new AbortController().signal, toolNames: [] })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toMatchObject({
      code: 'E_PRESET_UNRESOLVED',
      message: expect.stringContaining('Configure a model account'),
      detail: { reason: 'no-routes' },
    })
    expect(JSON.stringify(events(d))).not.toContain('test-lost-key')
    expect(typeof a.applyRuntimeTarget).toBe('function')
    const report = await a.applyRuntimeTarget(
      buildRuntimeTarget({
        rows: [],
        resources: { mcp: [], skills: {} },
        resourceRevision: '0'.repeat(64),
        compositeRevision: '0'.repeat(64),
      }),
    )
    expect(report.ok).toBe(true)
    await a.rollback.unwind()
  })
  it('a test provider has no registry, so no fingerprint is claimed for it', async () => {
    const p = await profileFor()
    const a = await assemble(p, deps(allModules()))
    expect(a.providerFingerprint).toBeNull()
    await a.rollback.unwind()
  })
  it('a real provider is verified against its sealed registry and its fingerprint recorded', async () => {
    const p = await profileFor()
    const d = deps(allModules())
    // The real provider, not the scripted one: the fingerprint and the registry check only exist on
    // this path, and a test that leaves the factory in place asserts on neither.
    delete d.providerFactory
    const a = await assemble(p, d)
    expect(a.providerFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(events(d).find((e) => e.kind === 'provider.assembled')?.detail?.fingerprint).toBe(
      a.providerFingerprint,
    )
    await a.rollback.unwind()
  })
  it('a route the sealed registry does not serve is refused at assembly, not mid-turn', async () => {
    // The profile declares gw; the preset asks for a slot model the catalogue does not carry, which
    // materializeRoutes lets through only because a route with an empty catalogue is the registry's
    // to fill. verifyRoutes is the half that reads what the adapters actually accepted.
    const ghost: RouteDecl = { route: 'gw', api: 'openai', baseUrl: 'https://gw.example/v1', models: [] }
    const p = await profileFor({
      provider: { package: '@agnes/ai', routes: [ghost] },
    })
    const pinned: PackageModule = {
      id: '@agnes/code',
      operations: {},
      presets: {
        standard: {
          name: 'standard',
          extends: 'base',
          model: { route: { primary: { route: 'gw', model: 'ghost-model' } } },
        },
      },
    }
    const d = deps({ '@agnes/base': baseModule(), '@agnes/code': pinned, '@agnes/ai': aiModule })
    delete d.providerFactory
    const e = await assemble(p, d).then(
      () => {
        throw new Error('expected a refusal')
      },
      (x: unknown) => x as { code: string; detail: { reason: string } },
    )
    expect(e.code).toBe('E_PRESET_UNRESOLVED')
    expect(e.detail.reason).toBe('model-unserved')
  })
  it('operations arrive as factories and are constructed with assembly-time dependencies', async () => {
    const p = await profileFor()
    const seen: string[] = []
    const withOp: PackageModule = {
      ...codeModule,
      operations: {
        probe: (d) => {
          seen.push(typeof d.adapters.storage === 'object' ? 'has-storage' : 'no-storage')
          seen.push(d.profile.preset.name === 'standard' ? 'has-preset' : 'no-preset')
          return {
            name: 'probe',
            slot: 'core',
            replay: 'safe',
            applicable: async () => 'skip',
            run: async () => ({}),
          }
        },
      },
    }
    const a = await assemble(
      p,
      deps({ '@agnes/base': baseModule(), '@agnes/code': withOp, '@agnes/ai': aiModule }),
    )
    expect(seen).toEqual(['has-storage', 'has-preset'])
    await a.rollback.unwind()
  })
  it('an operations factory that returns something that is not an Operation is refused', async () => {
    const p = await profileFor()
    const broken: PackageModule = {
      ...codeModule,
      operations: { bad: () => ({ name: 'bad' }) as never },
    }
    await expect(
      assemble(p, deps({ '@agnes/base': baseModule(), '@agnes/code': broken, '@agnes/ai': aiModule })),
    ).rejects.toThrow(/E_EXT_LOAD/)
  })

  // The extension manifest's own `id` must match `^[a-z0-9-]+/[a-z0-9-]+$` (protocol's
  // extension-manifest.json), which no `@agnes/*` package id can ever satisfy - so these two cases
  // use a package id that is itself schema-valid, standing in for a trusted third-party package.
  const widgetsProfile = (id: string) =>
    resolveProfile(
      {
        builtin: 'local-dev',
        lock: {
          packages: {
            ...lockPkgs,
            [id]: { version: '1.0.0', integrity: 'sha512-demo', trust: 'trusted' as const, enabled: true },
          },
        },
        user: {
          name: 'local-dev',
          presets: { default: 'standard', allowed: ['standard'] },
          packages: [{ id, source: 'trusted' }],
          provider: { package: '@agnes/ai', routes: [ROUTE] },
        },
      },
      env,
    )

  it('does not load a trusted package root extension through the managed host', async () => {
    const id = 'demo/widgets'
    const p = await widgetsProfile(id)
    const extDir = mkdtempSync(join(tmpdir(), 'agnes-ext-widgets-'))
    dirs.push(extDir)
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify(
        bundledPackageJson({
          id,
          version: '1.0.0',
          apiRange: '^5.0.0',
          entry: './index.ts',
          capabilities: { hooks: ['before_step'], slots: ['status.line'] },
        }),
      ),
    )
    writeFileSync(
      join(extDir, 'index.ts'),
      "export default (api) => { api.registerHook('before_step', () => ({})); " +
        "api.registerSlot('status.line', () => ({ text: 'loaded', level: 'info' })) }",
    )
    const d = deps({ ...allModules(), [id]: { id, operations: {}, extensionEntry: extDir } })
    d.packageDirs = new Map([
      ['@agnes/base', d.dataDir],
      ['@agnes/code', d.dataDir],
      ['@agnes/ai', d.dataDir],
      [id, extDir],
    ])
    d.extensionLoader = createLoader({
      cacheDir: join(d.dataDir, 'ext-cache'),
      hostRoot: process.cwd(),
      agnesVersion: '0.1.0',
    })
    await expect(assemble(p, d)).rejects.toMatchObject({
      code: 'E_EXT_LOAD',
      detail: { package: id, reason: 'snapshot-unavailable' },
    })
  })
  it('never preflights a retired third-party root extension', async () => {
    const id = 'demo/broken'
    const p = await widgetsProfile(id)
    const extDir = mkdtempSync(join(tmpdir(), 'agnes-ext-broken-'))
    dirs.push(extDir)
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify(
        bundledPackageJson({
          id: 'demo/not-broken', // deliberately not `id`: preflight refuses the identity mismatch
          version: '1.0.0',
          apiRange: '^5.0.0',
          entry: './index.ts',
          capabilities: {},
        }),
      ),
    )
    const d = deps({ ...allModules(), [id]: { id, operations: {}, extensionEntry: extDir } })
    d.packageDirs = new Map([
      ['@agnes/base', d.dataDir],
      ['@agnes/code', d.dataDir],
      ['@agnes/ai', d.dataDir],
      [id, extDir],
    ])
    await expect(assemble(p, d)).rejects.toMatchObject({
      code: 'E_EXT_LOAD',
      detail: { package: id, reason: 'snapshot-unavailable' },
    })
  })
})
