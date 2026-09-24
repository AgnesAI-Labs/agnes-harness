import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { Context } from '@agnes/cordis'
import type { RemoteTransport, SandboxSeam, SeamWorkspace } from '@agnes/core'
import { fakeSeams, testFsPolicy } from '@agnes/core/testkit'
import { hashDirectory, type RuntimePluginSnapshot, type RuntimeSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow, DYNAMIC_SEAM_NAMES } from '@agnes/plugin-runtime/host'
import type { Actor, ModelRecord, RouteDecl } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localFsIo } from '../../src/adapters/fs-io-local.js'
import { buildOrdinaryRows, type OrdinaryPluginLayers } from '../../src/assemble/ordinary-rows.js'
import { loadRuntimePackage, MemoryPackageLoader, type PackageModule } from '../../src/assemble/packages.js'
import { ASSEMBLY_STEPS, type AssembleDeps, assemble } from '../../src/assemble.js'
import { type AuditEvent, type AuditSink, createMemoryAudit } from '../../src/audit.js'
import { createLoader } from '../../src/ext-host/loader.js'
import { closeHost } from '../../src/lifecycle.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import { SessionWorkspaceRuntimeTable } from '../../src/session-workspace-runtime.js'
import { WorkspaceBindingAuthority } from '../../src/workspace-authority.js'
import { attachTestSeamPlugins } from '../../testkit/cordis-seams.js'

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
  '@agnes/ai': { version: '0.1.0', integrity: 'sha512-a', trust: 'builtin' as const, enabled: true },
  '@agnes/base': { version: '0.1.0', integrity: 'sha512-b', trust: 'builtin' as const, enabled: true },
  '@agnes/code': { version: '0.1.0', integrity: 'sha512-c', trust: 'builtin' as const, enabled: true },
}
const log = { debug() {}, info() {}, warn() {}, error() {} }
const SEAM_KEYS = [
  'approval',
  'checkpoint',
  'ledger',
  'sandbox',
  'verifier',
  'repair',
  'artifacts',
  'principals',
  'harness',
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
    // The sandbox fake answers for the workspace it is actually fitted into, the way any real
    // seam must: the assembly binds whatever fsPolicy() returns onto the workspace FsOps, and a
    // policy naming another root is refused.
    seams: Object.fromEntries(
      SEAM_KEYS.map((n) => [
        n,
        n === 'sandbox'
          ? async (ctx: { profile: { workspaceRoot: string } }) => ({
              ...seams.sandbox,
              fsPolicy: () => testFsPolicy(realpathSync(ctx.profile.workspaceRoot)),
            })
          : async () => seams[n],
      ]),
    ),
    operations: {},
    presets: { base: { name: 'base' } },
    ...over,
  }
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
        provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
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
        agnes: { plugins: [{ export: 'ordinary', id: 'ext:acme/late-trust' }] },
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
            provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
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
        agnes: { plugins: [{ export: 'ordinary', id: 'ext:acme/close-race' }] },
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
        agnes: { plugins: [{ export: 'boot', id: 'ext:acme/close-race-boot' }] },
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
          provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
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
    const originalSandboxFactory = modules['@agnes/base'].seams?.sandbox
    if (!originalSandboxFactory) throw new Error('missing test sandbox factory')
    modules['@agnes/base'] = {
      ...modules['@agnes/base'],
      sandboxWorkspaceProbe: async () => ({
        name: 'none',
        execBackend: 'none',
        enforcement: { level: 'partial', scope: ['file'] },
        degraded: true,
        confine: ({ argv }) => argv,
      }),
      seams: {
        ...modules['@agnes/base'].seams,
        sandbox: async (ctx) => {
          const template = (await originalSandboxFactory(ctx)) as SandboxSeam
          return {
            ...template,
            forWorkspace: async (workspace: SeamWorkspace): Promise<SandboxSeam> => ({
              ...template,
              forWorkspace: async () => {
                throw new Error('workspace seam is already fitted')
              },
              fsPolicy: () => workspace.policy,
              enforcement: () => workspace.enforcement,
              confine: async (argv) => {
                const backend = await workspace.readiness.ready()
                return [...(await backend.confine({ argv, cwd: workspace.root }))]
              },
              exec: (argv, options) =>
                workspace.exec(argv, {
                  ...options,
                  sandbox: { policyDigest: workspace.policy.digest, backend: workspace.execBackend },
                }),
            }),
          }
        },
      },
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
          canonicalRoot: realpathSync(d.workspaceRoot),
        },
        'session-a',
      )
      const runtime = await table.open(binding, () => assembled.openWorkspaceRuntime(binding))
      expect(runtime.root).toBe(realpathSync(d.workspaceRoot))
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

  it('assembles the eight required seam rows without exposing a third-party factory when no target selects one', async () => {
    const a = await assemble(
      await profileFor(),
      deps(allModules(), {
        pluginImporter: () => async () => undefined,
      }),
    )
    try {
      expect(a.pluginTree.bootRows.filter(({ id }) => id.startsWith('seam:')).map(({ id }) => id)).toEqual(
        DYNAMIC_SEAM_NAMES.map((name) => `seam:${name}`),
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
    const seams = module.seams as NonNullable<PackageModule['seams']>
    seams.approval = async (ctx) => ({
      ...original,
      ask: async () =>
        ctx.profile.preset.marker === 'updated' ? ('rejected' as const) : ('allowed-once' as const),
    })
    const originalPrincipals = fakeSeams().principals
    seams.principals = async () => ({ ...originalPrincipals, authorize })
    const profile = await profileFor()
    const assemblyDeps = deps({ '@agnes/base': module, '@agnes/code': codeModule, '@agnes/ai': aiModule })
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

  it('fails closed when a profile-selected third-party seam lacks an immutable runtime snapshot', async () => {
    const vendor = '@acme/approval'
    const approval = fakeSeams().approval
    const vendorModule = attachTestSeamPlugins({
      id: vendor,
      seams: {
        approval: async () => ({
          ...approval,
          ask: async () => 'rejected' as const,
        }),
      },
    })
    const verifiedPlugins = Object.freeze(
      (vendorModule.plugins ?? []).map((plugin) =>
        Object.freeze({
          ...plugin,
          candidate: Object.freeze({
            packageId: vendor,
            snapshotId: 'snapshot-vendor-1',
            exportName: plugin.declaration.export,
            generation: 7,
          }),
          snapshotDigest: 'sha512-vendor',
        }),
      ),
    )
    Object.defineProperty(vendorModule, 'plugins', {
      configurable: true,
      enumerable: true,
      value: verifiedPlugins,
    })
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
          provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
          seams: { approval: vendor },
          packages: [{ id: vendor, source: 'test' }],
        },
      },
      env,
    )
    await expect(
      assemble(
        profile,
        deps(
          {
            '@agnes/base': baseModule(),
            '@agnes/code': codeModule,
            '@agnes/ai': aiModule,
            [vendor]: vendorModule,
          },
          {
            pluginSnapshots: {
              async verify(candidate) {
                return {
                  packageId: candidate.packageId,
                  snapshotId: candidate.snapshotId,
                  generation: candidate.generation,
                  digest: 'sha512-vendor',
                  exports: (vendorModule.plugins ?? []).map(({ declaration }) => declaration.export),
                  trusted: true,
                }
              },
            },
          },
        ),
      ),
    ).rejects.toThrow('trusted package has no immutable runtime snapshot')
  })

  it('keeps a managed package available to Cordis when its immutable snapshot owns a selected seam', async () => {
    const vendor = '@acme/runtime-approval'
    const directory = mkdtempSync(join(tmpdir(), 'agnes-runtime-approval-'))
    dirs.push(directory)
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({
        name: vendor,
        version: '1.0.0',
        exports: './index.js',
        agnes: { plugins: [{ export: 'approvalPlugin', id: 'seam:approval' }] },
      })}\n`,
    )
    writeFileSync(join(directory, 'index.js'), 'export const marker = true\n')
    const snapshot: RuntimeSnapshot = Object.freeze({
      snapshotId: `sha256-${'7'.repeat(64)}`,
      profile: 'local-dev',
      packageId: vendor,
      version: '1.0.0',
      integrity: `sha256-${'8'.repeat(64)}`,
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'capability',
      directory,
      contributions: Object.freeze([]),
    })
    const directoryV2 = mkdtempSync(join(tmpdir(), 'agnes-runtime-approval-v2-'))
    dirs.push(directoryV2)
    writeFileSync(join(directoryV2, 'package.json'), readFileSync(join(directory, 'package.json')))
    writeFileSync(join(directoryV2, 'index.js'), 'export const marker = "v2"\n')
    const snapshotV2: RuntimeSnapshot = Object.freeze({
      ...snapshot,
      snapshotId: `sha256-${'c'.repeat(64)}`,
      integrity: `sha256-${'d'.repeat(64)}`,
      treeIntegrity: hashDirectory(directoryV2, { exclude: [] }),
      directory: directoryV2,
    })
    const observed = vi.fn()
    const approvalPlugin = Object.assign(
      (ctx: Context) => {
        observed(ctx.get('host:seam-init' as never))
        return ctx.provide('seam:approval', { ask: async () => 'rejected' as const })
      },
      { inject: ['host:seam-init'], provide: 'seam:approval' },
    )
    const approvalPluginV2 = Object.assign(
      (ctx: Context) => {
        observed(ctx.get('host:seam-init' as never))
        return ctx.provide('seam:approval', { ask: async () => 'allowed-once' as const })
      },
      { inject: ['host:seam-init'], provide: 'seam:approval' },
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
          provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
          seams: { approval: vendor },
          packages: [{ id: vendor, source: 'test' }],
        },
      },
      env,
    )
    const a = await assemble(
      profile,
      deps(allModules(), {
        runtimePluginSnapshots: [{ snapshot, generation: 4, trusted: true }],
        runtimePluginCatalogue: [
          { snapshot, generation: 4, trusted: true },
          { snapshot: snapshotV2, generation: 4, trusted: true },
        ],
        managedExtensionPackageIds: [vendor],
        extensionLoader: {
          import: async (file) =>
            file.includes('agnes-runtime-approval-v2-')
              ? { approvalPlugin: approvalPluginV2 }
              : { approvalPlugin },
        },
      }),
    )
    try {
      expect(observed).toHaveBeenCalledOnce()
      expect(await a.seams.approval.ask({} as never)).toBe('rejected')
      const firstRow = a.pluginTree.currentRows().find((row) => row.id === 'seam:approval')
      expect(firstRow).toMatchObject({
        plugin: `${vendor}@${snapshot.snapshotId}/approvalPlugin`,
      })
      if (!firstRow) throw new Error('missing assembled seam:approval row')
      // A complete target may re-point a third-party seam row at another catalogue snapshot; the
      // Host-private exact extras still gate the mount, so the row keeps its assembled extras.
      const upgraded = createPluginRow({
        id: firstRow.id,
        plugin: `${vendor}@${snapshotV2.snapshotId}/approvalPlugin`,
        snapshotDigest: snapshotV2.integrity,
        exportName: 'approvalPlugin',
        entryRevision: snapshotV2.snapshotId,
        extrasRevision: firstRow.extrasRevision,
        mountRevision: firstRow.mountRevision,
        config: firstRow.config,
        inject: firstRow.inject,
        provides: firstRow.provides,
        runtime: firstRow.runtime,
      })
      await publishRows(
        a,
        a.pluginTree.currentRows().map((row) => (row.id === 'seam:approval' ? upgraded : row)),
      )
      expect(await a.seams.approval.ask({} as never)).toBe('allowed-once')
      const secondRow = a.pluginTree.currentRows().find((row) => row.id === 'seam:approval')
      expect(secondRow).toMatchObject({
        plugin: `${vendor}@${snapshotV2.snapshotId}/approvalPlugin`,
        entryRevision: snapshotV2.snapshotId,
      })
      expect(secondRow?.mountIdentity).not.toBe(firstRow?.mountIdentity)
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
          provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
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
          provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
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
        agnes: { plugins: [{ export: 'ordinary', id: 'ext:acme/default-owner' }] },
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
          provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
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
        agnes: { plugins: [{ export: 'ordinary' }] },
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
    d.dataDir = realpathSync(d.dataDir)
    d.homeDir = realpathSync(d.homeDir ?? d.dataDir)
    d.workspaceRoot = realpathSync(d.workspaceRoot)
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
    const originalSandbox = baseModule().seams?.sandbox
    if (!originalSandbox) throw new Error('missing fixture sandbox')
    m[vendor] = {
      id: vendor,
      openTransport: async (config, ctx) => {
        order.push('open')
        expect(order.slice(0, -1).sort()).toEqual(Object.keys(m).sort())
        expect(config.opaque).toEqual({ value: 42 })
        expect(typeof ctx.secret).toBe('function')
        expect(ctx.signal).toBeInstanceOf(AbortSignal)
        return t
      },
      seams: {
        sandbox: async (ctx) => {
          const seam = (await originalSandbox(ctx)) as ReturnType<typeof fakeSeams>['sandbox']
          expect(ctx.sandboxHost?.transport).toBe(t)
          ctx.sandboxHost?.declareExecGate({ backend: 'remote', onUnavailable: 'deny' })
          return {
            ...seam,
            forWorkspace: async (workspace: SeamWorkspace): Promise<SandboxSeam> => ({
              ...seam,
              forWorkspace: async () => {
                throw new Error('already fitted')
              },
              exec: (argv, opts) =>
                workspace.exec(argv, {
                  ...opts,
                  sandbox: { backend: 'remote', policyDigest: workspace.policy.digest },
                }),
              fsPolicy: () => workspace.policy,
              enforcement: () => workspace.enforcement,
            }),
          }
        },
      },
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
          provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
          seams: { sandbox: vendor },
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

  it('assembles a kernel with ten seams, provider, presets and the resolved default preset', async () => {
    const p = await profileFor()
    const a = await assemble(p, deps(allModules()))
    expect(Object.keys(a.seams).sort()).toEqual([
      'approval',
      'artifacts',
      'checkpoint',
      'harness',
      'ledger',
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
  it('gives each seam a context bound to its own package and the seven profile fields base reads', async () => {
    const p = await profileFor()
    const seen: Array<Record<string, unknown>> = []
    const m = baseModule()
    const seams = m.seams as NonNullable<PackageModule['seams']>
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
  it('keeps Computer Use artifact retention out of a never-enabled profile', async () => {
    const p = await profileFor({ computerUse: { enabled: false } })
    const m = baseModule()
    const seams = m.seams as NonNullable<PackageModule['seams']>
    const originalArtifacts = seams.artifacts
    if (!originalArtifacts) throw new Error('missing fixture artifacts seam')
    let privateStoreInjected = false
    seams.artifacts = async (ctx) => {
      privateStoreInjected = ctx.privateArtifactStore !== undefined
      return originalArtifacts(ctx)
    }

    const a = await assemble(p, deps({ '@agnes/base': m, '@agnes/code': codeModule, '@agnes/ai': aiModule }))
    expect(privateStoreInjected).toBe(false)
    expect(a.computerUseArtifactGc).toBeUndefined()
    await a.rollback.unwind()
  })
  it('missing seam factory is E_SEAM_EXPORT_MISSING; a rejecting factory is E_SEAM_INIT; both roll back', async () => {
    const p = await profileFor()
    const noApproval = baseModule()
    delete (noApproval.seams as NonNullable<PackageModule['seams']>).approval
    await expect(
      assemble(p, deps({ '@agnes/base': noApproval, '@agnes/code': codeModule, '@agnes/ai': aiModule })),
    ).rejects.toThrow(/E_SEAM_EXPORT_MISSING/)
    const bad = baseModule()
    ;(bad.seams as NonNullable<PackageModule['seams']>).ledger = async () => {
      throw new Error('db down')
    }
    const d = deps({ '@agnes/base': bad, '@agnes/code': codeModule, '@agnes/ai': aiModule })
    await expect(assemble(p, d)).rejects.toThrow(/E_SEAM_INIT.*ledger/)
    expect(events(d).at(-1)).toMatchObject({ kind: 'startup.failed', detail: { step: 'seams' } })
  })
  it('reports the first seam in SEAM_NAMES order when two fail, not whichever rejected soonest', async () => {
    const p = await profileFor()
    const m = baseModule()
    const seams = m.seams as NonNullable<PackageModule['seams']>
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
    const seams = m.seams as NonNullable<PackageModule['seams']>
    seams.harness = async () => ({
      ...real.harness,
      close: () => {
        closed.push('harness')
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
    expect(closed.sort()).toEqual(['harness', 'repair'])
    // Cordis owns plugin cleanup and reports disposer failures through its logger while continuing
    // to tear down sibling rows. The Host rollback therefore completes instead of retaining the
    // legacy per-seam rollback label.
    expect(events(d).at(-1)?.detail?.rollbackFailed).toEqual([])
  })
  it('seam factory timeout is E_SEAM_INIT with reason timeout', async () => {
    const p = await profileFor()
    const slow = baseModule()
    ;(slow.seams as NonNullable<PackageModule['seams']>).verifier = () => new Promise(() => {})
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
    ;(m.seams as NonNullable<PackageModule['seams']>).harness = async () => 'not a seam'
    await expect(
      assemble(p, deps({ '@agnes/base': m, '@agnes/code': codeModule, '@agnes/ai': aiModule })),
    ).rejects.toThrow(/E_SEAM_INIT.*non-object/)
  })
  it('a seam with a close() is torn down by the rollback, once', async () => {
    const p = await profileFor()
    let closed = 0
    const m = baseModule()
    const seams = m.seams as NonNullable<PackageModule['seams']>
    const real = fakeSeams()
    seams.harness = async () => ({
      ...real.harness,
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
  it('assembles applyRuntimeTarget when the profile declares no provider.routes', async () => {
    const p = await profileFor({
      provider: { package: '@agnes/ai', adapters: ['@agnes/ai'] },
    })
    const d = deps(allModules())
    delete d.providerFactory
    d.allowUnresolvedProvider = true
    const a = await assemble(p, d)
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
      provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ghost] },
    })
    const pinned: PackageModule = {
      id: '@agnes/code',
      operations: {},
      presets: { standard: { name: 'standard', extends: 'base', model: { id: { primary: 'ghost-model' } } } },
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
          packages: [{ id, source: 'trusted' }],
          provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [ROUTE] },
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
      join(extDir, 'agnes.extension.json'),
      JSON.stringify({
        id,
        version: '1.0.0',
        apiRange: '^1.0',
        entry: './index.ts',
        capabilities: { hooks: ['before_step'], slots: ['status.line'] },
      }),
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
      join(extDir, 'agnes.extension.json'),
      JSON.stringify({
        id: 'demo/not-broken', // deliberately not `id`: preflight refuses the identity mismatch
        version: '1.0.0',
        apiRange: '^1.0',
        entry: './index.ts',
        capabilities: {},
      }),
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
