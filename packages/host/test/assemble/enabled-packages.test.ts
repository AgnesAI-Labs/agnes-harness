import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { fakeSeams } from '@agnes/core/testkit'
import type { HookEvent, HookReturnMap } from '@agnes/extension-api'
import { parseAgnesPluginEntries } from '@agnes/package-manager'
import type { RouteDecl } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { readNamedExports } from '../../src/assemble/packages.js'
import { type AssembleDeps, assemble } from '../../src/assemble.js'
import { type AuditEvent, type AuditSink, createMemoryAudit } from '../../src/audit.js'
import { resolveProfile } from '../../src/profile/resolve.js'

const roots: string[] = []
const packagedIsolation = it.runIf(Boolean(process.env.AGNES_TEST_RUNTIME_DIRECTORY))
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const ids = ['@agnes/ai', '@agnes/base', '@agnes/code']
const route: RouteDecl = {
  route: 'gw',
  api: 'openai',
  baseUrl: 'http://127.0.0.1:1',
  models: [
    {
      id: 'm',
      name: 'm',
      api: 'openai',
      route: 'gw',
      baseUrl: 'http://127.0.0.1:1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
      toolCallFormats: ['native'],
      thinkingReplay: 'native',
      contract_id: null,
    },
  ],
}

async function setup(projections = false) {
  const root = mkdtempSync(join(tmpdir(), 'agnes-enabled-'))
  roots.push(root)
  const profile = await resolveProfile(
    {
      builtin: 'local-dev',
      lock: {
        packages: Object.fromEntries(
          ids.map((id) => [
            id,
            { version: '0.1.0', integrity: 'sha512-test', trust: 'builtin', enabled: true },
          ]),
        ),
      },
      user: {
        name: 'local-dev',
        ...(projections
          ? {
              policy: {
                capabilityCeiling: [
                  'tools',
                  'hooks',
                  'slots',
                  'events',
                  'resources',
                  'network',
                  'tools.invoke',
                  'artifacts',
                  'subagent',
                  'projections',
                ] as const,
              },
            }
          : {}),
        provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [route] },
      },
    },
    {
      platform: { os: 'linux', arch: 'x64', capabilities: {} },
      agnesVersion: '0.1.0',
      now: '2026-09-09T00:00:00Z',
    },
  )
  const imported: string[] = []
  const packageDirs = new Map(
    ids.map((id) => [id, fileURLToPath(new URL(`../../../${id.slice(7)}/`, import.meta.url))]),
  )
  const deps: AssembleDeps = {
    // The sandbox policy the real base seam compiles refuses to compile when the data directory
    // IS the workspace (an allow and a deny at one canonical path), so the fixture gives the
    // installation its own directory beneath it - which is also the shape a real deployment has.
    dataDir: join(root, 'agnes-data'),
    workspaceRoot: root,
    homeDir: join(root, 'home'),
    profileDir: join(root, 'profile'),
    hostRoot: root,
    packageDirs,
    audit: createMemoryAudit(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    providerFactory: () => new ScriptedProvider({ scripts: [] }),
    env: { ...process.env },
    loader: {
      async importPackage(id, dir) {
        imported.push(id)
        const mod =
          id === '@agnes/base'
            ? await import('@agnes/base')
            : id === '@agnes/code'
              ? await import('@agnes/code')
              : id === '@agnes/ai'
                ? await import('@agnes/ai')
                : await import(pathToFileURL(join(dir, 'index.mjs')).href)
        const declarations =
          id === '@agnes/base'
            ? parseAgnesPluginEntries(
                id,
                (
                  JSON.parse(readFileSync(join(packageDirs.get(id) ?? dir, 'package.json'), 'utf8')) as {
                    agnes?: { plugins?: unknown }
                  }
                ).agnes?.plugins,
              )
            : []
        const result = readNamedExports(id, dir, mod, declarations)
        // This test owns package selection, not the remaining base seams awaiting implementation.
        // Keep the real exported seams and fill only those unrelated assembly dependencies.
        if (id === '@agnes/base') {
          const fallback = fakeSeams()
          result.seams = {
            ...Object.fromEntries(
              Object.entries(fallback)
                .filter(([name]) => name !== 'platform' && name !== 'sandbox')
                .map(([name, value]) => [name, async () => value]),
            ),
            ...result.seams,
          }
        }
        return result
      },
    },
  }
  // Both a module import and a bundled extension factory write observable files. If package
  // filtering protects only one of the two assembly stages, the other marker still catches it.
  const extra = join(root, 'extra')
  mkdirSync(join(extra, 'ext'), { recursive: true })
  const moduleMarker = join(root, 'module-ran'),
    extensionMarker = join(root, 'extension-ran')
  writeFileSync(
    join(extra, 'index.mjs'),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(moduleMarker)},'yes'); export const presets={forbidden:{name:'forbidden'}}; export const operations={};`,
  )
  writeFileSync(
    join(extra, 'package.json'),
    JSON.stringify({ type: 'module', agnes: { extensions: ['./ext'] } }),
  )
  writeFileSync(
    join(extra, 'ext', 'agnes.extension.json'),
    JSON.stringify({
      id: 'agnes/enabled-test',
      version: '1.0.0',
      apiRange: '^1.0.0',
      // The current extension-manifest schema requires a `./`-prefixed entry (protocol's
      // extension-manifest.json `entry` pattern `^\./`); the old bare `'index.mjs'` here predates
      // that and only ever passed the legacy reader's looser check, not the new one.
      entry: './index.mjs',
      capabilities: {},
    }),
  )
  writeFileSync(
    join(extra, 'ext', 'index.mjs'),
    `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(extensionMarker)},'yes')}`,
  )
  return {
    profile: structuredClone(profile),
    deps,
    imported,
    packageDirs,
    extra,
    moduleMarker,
    extensionMarker,
  }
}

it.each(['absent', 'disabled'] as const)(
  'directory for %s package grants no import, preset or extension authority',
  async (state) => {
    const x = await setup()
    x.packageDirs.set('@agnes/extra', x.extra)
    if (state === 'disabled')
      x.profile.packages.push({
        id: '@agnes/extra',
        source: 'builtin:@agnes/extra',
        version: '0.1.0',
        integrity: 'sha512-extra',
        trust: 'builtin',
        enabled: false,
      })
    const a = await assemble(x.profile, x.deps)
    try {
      expect(x.imported).toEqual(x.profile.packages.filter((p) => p.enabled).map((p) => p.id))
      expect(existsSync(x.moduleMarker)).toBe(false)
      expect(existsSync(x.extensionMarker)).toBe(false)
      expect(a.presets).not.toHaveProperty('forbidden')
      expect(a.extHost.status().some((e) => e.package === '@agnes/extra')).toBe(false)
      expect(a.defaultPreset.view.name).toBe('standard')
      expect(a.extHost.status().some((e) => e.package === '@agnes/extra')).toBe(false)
    } finally {
      await a.rollback.unwind()
    }
  },
)

it('enabled directory imports its package without executing a retired bundled extension', async () => {
  const x = await setup()
  x.packageDirs.set('@agnes/extra', x.extra)
  x.profile.packages.push({
    id: '@agnes/extra',
    source: 'builtin:@agnes/extra',
    version: '0.1.0',
    integrity: 'sha512-extra',
    trust: 'builtin',
    enabled: true,
  })
  const a = await assemble(x.profile, x.deps)
  try {
    expect(existsSync(x.moduleMarker)).toBe(true)
    expect(existsSync(x.extensionMarker)).toBe(false)
    expect(a.presets).toHaveProperty('forbidden')
    expect(a.extHost.status().find((e) => e.package === '@agnes/extra')).toBeUndefined()
  } finally {
    await a.rollback.unwind()
  }
})

it('missing required location refuses before any import and a corrected map recovers', async () => {
  const x = await setup()
  const base = x.packageDirs.get('@agnes/base') as string
  x.packageDirs.delete('@agnes/base')
  await expect(assemble(x.profile, x.deps)).rejects.toMatchObject({
    code: 'E_DEP_MISSING',
    detail: { package: '@agnes/base' },
  })
  expect(x.imported).toEqual([])
  x.packageDirs.set('@agnes/base', base)
  const a = await assemble(x.profile, x.deps)
  expect(a.defaultPreset.view.name).toBe('standard')
  await a.rollback.unwind()
})

it('keeps bundled extensions in-process by default without probing an isolation runtime', async () => {
  const x = await setup()
  const prepareRuntime = vi.fn(() => {
    throw new Error('must not run')
  })
  x.deps.extensionIsolationServices = { prepareRuntime }
  const a = await assemble(x.profile, x.deps)
  try {
    expect(prepareRuntime).not.toHaveBeenCalled()
    expect(a.extensionStatus().find((status) => status.id === 'agnes/hooks-runner')).toMatchObject({
      loaded: true,
    })
    expect(a.extensionStatus().find((status) => status.id === 'agnes/hooks-runner')?.isolation).toEqual({
      mode: 'off',
      backend: 'in-process',
      fallback: false,
    })
  } finally {
    await a.rollback.unwind()
  }
})

it('falls back before extension preparation when preferred isolation is unavailable', async () => {
  const x = await setup()
  const startRunner = vi.fn()
  x.deps.extensionIsolation = { extensions: { 'agnes/hooks-runner': 'preferred' } }
  x.deps.extensionIsolationServices = {
    prepareRuntime: () => {
      throw new Error('backend absent')
    },
    startRunner,
  }
  const a = await assemble(x.profile, x.deps)
  try {
    expect(startRunner).not.toHaveBeenCalled()
    expect(a.extensionStatus().find((status) => status.id === 'agnes/hooks-runner')).toMatchObject({
      loaded: true,
      isolation: { mode: 'preferred', backend: 'in-process', fallback: true },
    })
    expect((x.deps.audit as ReturnType<typeof createMemoryAudit>).events).toContainEqual(
      expect.objectContaining({ kind: 'extension.isolation-fallback' }),
    )
  } finally {
    await a.rollback.unwind()
  }
})

it('loads required hooks-runner through the isolated factory and removes it after a child crash', async () => {
  const x = await setup()
  let failRunner: ((error: Error) => void) | undefined
  const close = vi.fn(async () => undefined)
  x.deps.extensionIsolation = { extensions: { 'agnes/hooks-runner': 'required' } }
  x.deps.extensionIsolationServices = {
    prepareRuntime: () => ({
      backend: 'seatbelt',
      runtime: {
        source: 'bundled',
        executable: '/release/node',
        runner: '/release/hooks-runner.mjs',
        readPaths: ['/release'],
        runnerSha256: '0'.repeat(64),
      },
    }),
    startRunner: async () => ({
      pid: 4242,
      events: ['before_step'],
      onFailure(listener) {
        failRunner = listener
        return () => {
          failRunner = undefined
        }
      },
      invoke: async <E extends HookEvent>() => ({ block: false }) as HookReturnMap[E],
      close,
    }),
  }
  const a = await assemble(x.profile, x.deps)
  try {
    expect(a.extensionStatus().find((status) => status.id === 'agnes/hooks-runner')).toMatchObject({
      loaded: true,
      isolation: {
        mode: 'required',
        backend: 'seatbelt',
        fallback: false,
        pid: 4242,
        protocol: 1,
      },
    })
    expect(a.kernel.hooks.snapshot('agnes/hooks-runner').entries('before_step')).toHaveLength(1)
    failRunner?.(new Error('child crashed'))
    await vi.waitFor(() => {
      expect(a.extensionStatus().find((status) => status.id === 'agnes/hooks-runner')).toMatchObject({
        loaded: false,
        error: { code: 'E_EXT_LOAD' },
      })
      expect(a.kernel.hooks.snapshot('agnes/hooks-runner').entries('before_step')).toHaveLength(0)
    })
    expect(a.kernel).toBeDefined()
    expect(close).toHaveBeenCalledOnce()
  } finally {
    await a.rollback.unwind()
  }
})

it('keeps Host alive but leaves a required extension unloaded when isolation is unavailable', async () => {
  const x = await setup()
  x.deps.extensionIsolation = { extensions: { 'agnes/hooks-runner': 'required' } }
  x.deps.extensionIsolationServices = {
    prepareRuntime: () => {
      throw new Error('backend absent')
    },
  }
  const a = await assemble(x.profile, x.deps)
  try {
    expect(a.kernel).toBeDefined()
    expect(a.extensionStatus().find((status) => status.id === 'agnes/hooks-runner')).toMatchObject({
      loaded: false,
      isolation: { mode: 'required', backend: 'unavailable', fallback: false },
      error: { code: 'E_EXT_ISOLATION_UNAVAILABLE', message: 'extension factory failed' },
    })
  } finally {
    await a.rollback.unwind()
  }
})

packagedIsolation('runs an opted-in hook through the packaged Node runner and real Seatbelt', async () => {
  const runtimeDirectory = resolve(process.env.AGNES_TEST_RUNTIME_DIRECTORY as string)
  const x = await setup()
  mkdirSync(x.deps.dataDir, { recursive: true })
  writeFileSync(
    join(x.deps.dataDir, 'hooks.json'),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: `printf '%s' '{"decision":"block","reason":"isolated package"}'`,
              },
            ],
          },
        ],
      },
    }),
  )
  x.deps.hostRoot = dirname(dirname(runtimeDirectory))
  x.deps.extensionIsolation = { extensions: { 'agnes/hooks-runner': 'required' } }
  const a = await assemble(x.profile, x.deps)
  try {
    expect(a.extensionStatus().find((status) => status.id === 'agnes/hooks-runner')).toMatchObject({
      loaded: true,
      isolation: { mode: 'required', backend: 'seatbelt', fallback: false, protocol: 1 },
    })
    const session = await a.kernel.session('t6-3-real', {
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      resolvedProfileHash: x.profile.hash,
      cwd: x.deps.workspaceRoot,
      writerRunId: 't6-3-writer',
    })
    const result = await session.hooks.beforeStep({ turn: 1, step: 1, depth: 0 })
    expect(result).toMatchObject({ block: true, reason: 'isolated package' })
  } finally {
    await a.rollback.unwind()
  }
})

it('omitting the location map preserves the enabled-package default path', async () => {
  const x = await setup()
  delete x.deps.packageDirs
  const locations: string[] = []
  const loader = x.deps.loader
  x.deps.loader = {
    async importPackage(id, dir) {
      locations.push(dir)
      return loader.importPackage(id, dir)
    },
  }
  const a = await assemble(x.profile, x.deps)
  try {
    expect(locations).toEqual(x.profile.packages.filter((p) => p.enabled).map(() => x.deps.dataDir))
  } finally {
    await a.rollback.unwind()
  }
})

it('a disabled seam provider is refused even when its directory is supplied', async () => {
  const x = await setup()
  const base = x.profile.packages.find((p) => p.id === '@agnes/base')
  if (!base) throw new Error('test profile has no base package')
  base.enabled = false
  await expect(assemble(x.profile, x.deps)).rejects.toMatchObject({
    code: 'E_DEP_MISSING',
    detail: { seam: 'approval', package: '@agnes/base' },
  })
  expect(x.imported).not.toContain('@agnes/base')
})
it('consumes resolved required policy despite a weaker legacy constructor option', async () => {
  const x = await setup()
  const { withAssemblyIsolation } = await import('../../src/profile/isolation.js')
  const { createHost } = await import('../../src/host.js')
  const profile = withAssemblyIsolation(x.profile, { extensions: { 'agnes/hooks-runner': 'required' } })
  x.deps.extensionIsolation = { extensions: { 'agnes/hooks-runner': 'off' } }
  const prepareRuntime = vi.fn(() => {
    throw Error('backend unavailable')
  })
  x.deps.extensionIsolationServices = { prepareRuntime }
  const host = await createHost(profile, x.deps)
  try {
    expect(host.profile.hash).toBe(profile.hash)
    expect(host.profile.extensionIsolation?.extensions['agnes/hooks-runner']).toBe('required')
    expect(prepareRuntime).toHaveBeenCalledOnce()
    expect(host.extensions().find((entry) => entry.id === 'agnes/hooks-runner')).toMatchObject({
      loaded: false,
      isolation: { mode: 'required', backend: 'unavailable', fallback: false },
      error: { code: 'E_EXT_ISOLATION_UNAVAILABLE' },
    })
  } finally {
    await host.close()
  }
})

async function installedHookFixture(
  mode: 'off' | 'preferred' | 'required',
  code: string,
  bundled = false,
  entryFile = 'index.mjs',
) {
  const x = await setup()
  const { createPackageManager, emptyLock, parseSource, writeLock } = await import('@agnes/package-manager')
  x.deps.profileDir = join(x.deps.workspaceRoot, 'profiles', x.profile.name)
  const id = 'acme/generic'
  const author = bundled ? 'acme/bundled' : id
  const sourceDirectory = join(x.deps.workspaceRoot, 'generic-source')
  const extensionDirectory = bundled ? join(sourceDirectory, 'extension') : sourceDirectory
  mkdirSync(extensionDirectory, { recursive: true })
  mkdirSync(x.deps.profileDir, { recursive: true })
  writeFileSync(
    join(sourceDirectory, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      license: 'MIT',
      type: 'module',
      ...(bundled ? { agnes: { extensions: ['./extension'] } } : {}),
    }),
  )
  if (bundled)
    writeFileSync(join(sourceDirectory, 'index.mjs'), 'throw Error("package entry must not execute")')
  writeFileSync(
    join(extensionDirectory, 'agnes.extension.json'),
    JSON.stringify({
      id: author,
      version: '1.0.0',
      apiRange: '^1.0.0',
      entry: `./${entryFile}`,
      capabilities: { hooks: ['before_step', 'session_start', 'subagent_start', 'context'], events: true },
      runtime: { supports: ['in-process', 'isolated'] },
    }),
  )
  writeFileSync(
    join(extensionDirectory, entryFile),
    code.replaceAll('__WORKSPACE__', JSON.stringify(x.deps.workspaceRoot)),
  )
  writeFileSync(join(x.deps.workspaceRoot, 'private-probe'), 'fixture-private')
  writeLock(x.deps.profileDir, {
    ...emptyLock(x.profile.name, '0.1.0'),
    resolvedProfileHash: x.profile.hash,
    seams: x.profile.seams,
    provider: { package: x.profile.provider.package, adapters: x.profile.provider.adapters },
    policySnapshot: { capabilityCeiling: ['hooks', 'events'], workspacePackages: 'require-project-trust' },
  })
  const manager = createPackageManager({
    dataDir: x.deps.dataDir,
    cwd: x.deps.workspaceRoot,
    agnesVersion: '0.1.0',
    references: async () => [],
  })
  const source = parseSource('file:./generic-source')
  const preview = await manager.inspect(x.deps.profileDir, source)
  await manager.install(x.deps.profileDir, source, { expectedIntegrity: preview.integrity })
  const row = (await manager.inventory(x.deps.profileDir)).packages[0]
  if (!row?.directory) throw Error('missing installed fixture')
  await manager.trust(x.deps.profileDir, id, {
    integrity: row.entry.integrity,
    capabilityHash: row.capabilityHash,
  })
  await manager.enable(x.deps.profileDir, id, true)
  x.packageDirs.set(id, row.directory)
  x.profile.packages.push({
    id,
    source: source.ref,
    version: row.entry.version,
    integrity: row.entry.integrity,
    trust: 'trusted',
    enabled: true,
  })
  x.deps.extensionIsolation = { extensions: { [author]: mode } }
  x.deps.hostRoot = dirname(dirname(resolve(process.env.AGNES_TEST_RUNTIME_DIRECTORY as string)))
  return { ...x, id, author, manager }
}

packagedIsolation.each([false, true])(
  'installs and invokes a generic Hook in real Seatbelt (bundled=%s)',
  async (bundled) => {
    const x = await installedHookFixture(
      'required',
      `import {defineExtension} from '@agnes/extension-api';
    import {Type} from '@sinclair/typebox';
    export default defineExtension(api => {
      const schema = Type.String();
      api.registerHook('before_step', async () => ({block:true, reason:'generic-' + process.pid + '-' + schema.type}));
    });`,
      bundled,
    )
    const a = await assemble(x.profile, x.deps)
    let pid: number | undefined
    try {
      expect(x.imported).not.toContain(x.id)
      const status = a.extHost.status().find((row) => row.id === x.author)
      expect(status).toMatchObject({
        loaded: true,
        isolation: { mode: 'required', backend: 'seatbelt', fallback: false },
      })
      pid = status?.isolation?.pid
      expect(pid).toBeTypeOf('number')
      expect(pid).not.toBe(process.pid)
      const session = await a.kernel.session('generic-real', {
        actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        resolvedProfileHash: x.profile.hash,
        cwd: x.deps.workspaceRoot,
        writerRunId: 'generic-writer',
      })
      expect(await session.hooks.beforeStep({ turn: 1, step: 1, depth: 0 })).toMatchObject({
        block: true,
        reason: `generic-${pid}-string`,
      })
    } finally {
      await a.rollback.unwind()
    }
    if (pid) expect(() => process.kill(pid, 0)).toThrow()
    expect(a.extHost.residue(x.author)).toEqual([])
  },
)

packagedIsolation(
  'four generic Hook modes match in-process oracle through actual Host sessions',
  async () => {
    const code = `export default api => {
      api.registerHook('session_start', async () => { await api.events.append('parallel', {mode:'parallel'}) });
      api.registerHook('subagent_start', async () => { await api.events.append('emit', {mode:'emit'}) });
      api.registerHook('before_step', async (_,ctx) => { await api.events.append('serial', {mode:'serial'}); return {block:true,reason:String(ctx.lease.budget.remaining)} });
      api.registerHook('context', async p => { await api.events.append('waterfall', {mode:'waterfall',surface:p.getSurface().length}); return {additionalContext:'generic context'} });
    };`
    const results = []
    for (const mode of ['off', 'required'] as const) {
      const x = await installedHookFixture(mode, code)
      const a = await assemble(x.profile, x.deps)
      try {
        expect(a.extHost.status().find((r) => r.id === x.author)?.loaded).toBe(true)
        const session = await a.kernel.session('modes-real', {
          actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
          resolvedProfileHash: x.profile.hash,
          cwd: x.deps.workspaceRoot,
          writerRunId: 'modes-writer',
        })
        await session.hooks.subagentStart?.({ childKey: 'child', kind: 'spawn', budget: null })
        const serial = await session.hooks.beforeStep({ turn: 1, step: 1, depth: 0 })
        const waterfall = await session.hooks.context([])
        const events = []
        for (const name of ['parallel', 'emit', 'serial', 'waterfall'])
          events.push(
            (await session.scan({ type: `x/${x.author}/${name}`, toSeq: session.lastSeq })).map(
              (e) => e.data,
            ),
          )
        results.push({ serial, waterfall, events })
        expect(serial).toEqual({ block: true, reason: 'Infinity' })
        expect(events.every((e) => e.length === 1)).toBe(true)
      } finally {
        await a.rollback.unwind()
      }
    }
    expect(results[1]).toEqual(results[0])
  },
)

packagedIsolation('generic Hook cannot read workspace, write files, connect network or fork', async () => {
  const x = await installedHookFixture(
    'required',
    `import {readFileSync,writeFileSync} from 'node:fs';
    import {spawnSync} from 'node:child_process'; import {connect} from 'node:net';
    export default api => { api.registerHook('before_step', async () => {
      const blocked=[];
      try {readFileSync(__WORKSPACE__+'/private-probe')} catch {blocked.push('read')}
      try {writeFileSync(__WORKSPACE__+'/forbidden-write','bad')} catch {blocked.push('write')}
      if(spawnSync(process.execPath,['-e','process.exit(0)']).error) blocked.push('fork');
      await new Promise(resolve=>{const socket=connect(1,'127.0.0.1');socket.on('error',error=>{if(error.code==='EPERM'||error.code==='EACCES')blocked.push('net');resolve()});socket.on('connect',()=>{socket.destroy();resolve()})});
      return {block:true,reason:blocked.join(',')};
    }) }`,
  )
  const a = await assemble(x.profile, x.deps)
  try {
    expect(a.extHost.status().find((r) => r.id === x.author)?.loaded).toBe(true)
    const session = await a.kernel.session('confined-real', {
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      resolvedProfileHash: x.profile.hash,
      cwd: x.deps.workspaceRoot,
      writerRunId: 'confined-writer',
    })
    expect(await session.hooks.beforeStep({ turn: 1, step: 1, depth: 0 })).toEqual({
      block: true,
      reason: 'read,write,fork,net',
    })
    expect(existsSync(join(x.deps.workspaceRoot, 'forbidden-write'))).toBe(false)
  } finally {
    await a.rollback.unwind()
  }
})

packagedIsolation.each(['process.exit(71)', 'while(true){}'])(
  'generic Runner failure clears owner, lease and PID: %s',
  async (failure) => {
    const x = await installedHookFixture(
      'required',
      `export default api => {api.registerHook('before_step', () => {${failure}})}`,
    )
    const a = await assemble(x.profile, x.deps)
    const pid = a.extHost.status().find((r) => r.id === x.author)?.isolation?.pid
    try {
      expect(pid).toBeTypeOf('number')
      const session = await a.kernel.session('failure-real', {
        actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        resolvedProfileHash: x.profile.hash,
        cwd: x.deps.workspaceRoot,
        writerRunId: 'failure-writer',
      })
      expect(await session.hooks.beforeStep({ turn: 1, step: 1, depth: 0 })).toMatchObject({ block: true })
      await expect
        .poll(() => a.extHost.status().find((r) => r.id === x.author)?.loaded, { timeout: 3000 })
        .toBe(false)
      expect(a.extHost.status().find((r) => r.id === x.author)?.lease).toBeUndefined()
      await expect.poll(() => a.extHost.residue(x.author), { timeout: 3000 }).toEqual([])
      expect(() => process.kill(pid as number, 0)).toThrow()
      expect(a.extHost.status().some((r) => r.package === '@agnes/base' && r.loaded)).toBe(true)
    } finally {
      await a.rollback.unwind()
    }
  },
)

packagedIsolation('preferred never replays a generic factory after preparation starts', async () => {
  const x = await installedHookFixture('preferred', 'export default () => {throw Error("factory failed")}')
  const a = await assemble(x.profile, x.deps)
  try {
    expect(x.imported).not.toContain(x.id)
    expect(a.extHost.status().find((r) => r.id === x.author)).toMatchObject({
      loaded: false,
      isolation: { mode: 'preferred', backend: 'seatbelt', fallback: false },
    })
    expect(a.extHost.residue(x.author)).toEqual([])
  } finally {
    await a.rollback.unwind()
  }
})

packagedIsolation('changed installed bytes refuse required before any source import', async () => {
  const x = await installedHookFixture('required', 'export default () => {}')
  writeFileSync(
    join(x.packageDirs.get(x.id) as string, 'index.mjs'),
    'throw Error("changed tree must not execute")',
  )
  const a = await assemble(x.profile, x.deps)
  try {
    expect(x.imported).not.toContain(x.id)
    expect(a.extHost.status().find((r) => r.id === x.author)).toMatchObject({
      loaded: false,
      error: { code: 'E_EXT_ISOLATION_UNAVAILABLE' },
    })
  } finally {
    await a.rollback.unwind()
  }
})

packagedIsolation(
  'generic Hook withdrawal removes its Host proxy and late sync registration is refused',
  async () => {
    const x = await installedHookFixture(
      'required',
      `export default api => {
    let lateRefused='';
    const dispose=api.registerHook('before_step', () => {dispose();return {block:true,reason:String(lateRefused)}});
    queueMicrotask(()=>{try{api.registerHook('context',()=>({}))}catch(e){lateRefused=e.code}});
  }`,
    )
    const a = await assemble(x.profile, x.deps)
    try {
      expect(a.extHost.status().find((r) => r.id === x.author)?.loaded).toBe(true)
      const session = await a.kernel.session('withdraw-real', {
        actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        resolvedProfileHash: x.profile.hash,
        cwd: x.deps.workspaceRoot,
        writerRunId: 'withdraw-writer',
      })
      expect(await session.hooks.beforeStep({ turn: 1, step: 1, depth: 0 })).toEqual({
        block: true,
        reason: 'E_CAPABILITY_UNDECLARED',
      })
      expect(a.extHost.residue(x.author)).toEqual([])
      expect(a.kernel.hooks.snapshot(x.author).entries('before_step')).toEqual([])
      expect(await session.hooks.beforeStep({ turn: 1, step: 2, depth: 0 })).toEqual({
        block: true,
        reason: 'E_CAPABILITY_UNDECLARED',
      })
    } finally {
      await a.rollback.unwind()
    }
  },
)

packagedIsolation('loads TypeScript author code through the packaged static jiti runtime', async () => {
  const x = await installedHookFixture(
    'required',
    `import {defineExtension,type ExtensionAPI} from '@agnes/extension-api';
    const reason: string = 'typed runner'; export default defineExtension((api:ExtensionAPI) => {
      api.registerHook('before_step', () => ({block:true,reason}));
    });`,
    false,
    'index.ts',
  )
  const a = await assemble(x.profile, x.deps)
  try {
    expect(a.extHost.status().find((r) => r.id === x.author)?.loaded).toBe(true)
    const session = await a.kernel.session('typed-real', {
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      resolvedProfileHash: x.profile.hash,
      cwd: x.deps.workspaceRoot,
      writerRunId: 'typed-writer',
    })
    expect(await session.hooks.beforeStep({ turn: 1, step: 1, depth: 0 })).toEqual({
      block: true,
      reason: 'typed runner',
    })
  } finally {
    await a.rollback.unwind()
  }
})

packagedIsolation(
  'withdrawal in a synchronous factory microtask is absent from the initial proposal',
  async () => {
    const x = await installedHookFixture(
      'required',
      `export default api => {
    const dispose=api.registerHook('before_step',()=>({block:true}));queueMicrotask(dispose);
  }`,
    )
    const a = await assemble(x.profile, x.deps)
    try {
      expect(a.extHost.status().find((r) => r.id === x.author)?.loaded).toBe(true)
      expect(a.extHost.residue(x.author)).toEqual([])
      expect(a.kernel.hooks.snapshot(x.author).entries('before_step')).toEqual([])
    } finally {
      await a.rollback.unwind()
    }
  },
)

packagedIsolation(
  'preserves multiple registrations per event and public capability error codes',
  async () => {
    const x = await installedHookFixture(
      'required',
      `
    export default api => {
      let undeclared;
      try { api.registerTool({}); } catch (e) { undeclared = e.code; }
      const first = api.registerHook('before_step', async () => {
        first();
        try { await api.events.append('outside/namespace', {}); }
        catch (e) { return {block: false, reason: e.code}; }
      });
      api.registerHook('before_step', () => ({block:true,reason:undeclared}));
    }
  `,
    )
    const a = await assemble(x.profile, x.deps)
    try {
      expect(a.extHost.status().find((r) => r.id === x.author)?.loaded).toBe(true)
      expect(a.kernel.hooks.snapshot(x.author).entries('before_step')).toHaveLength(2)
      const session = await a.kernel.session('multiple-real', {
        actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        resolvedProfileHash: x.profile.hash,
        cwd: x.deps.workspaceRoot,
        writerRunId: 'multiple-writer',
      })
      expect(await session.hooks.beforeStep({ turn: 1, step: 1, depth: 0 })).toEqual({
        block: true,
        reason: 'E_CAPABILITY_UNDECLARED',
      })
      expect(a.kernel.hooks.snapshot(x.author).entries('before_step')).toHaveLength(1)
    } finally {
      await a.rollback.unwind()
    }
  },
)

packagedIsolation('preserves sanitized Host capability error codes across IPC', async () => {
  const x = await installedHookFixture(
    'required',
    `export default api => {
    api.registerHook('before_step', async () => {
      try {await api.events.append('outside/namespace', {})}
      catch(e) {return {block:true,reason:e.code}}
    });
  }`,
  )
  const a = await assemble(x.profile, x.deps)
  try {
    const session = await a.kernel.session('error-real', {
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      resolvedProfileHash: x.profile.hash,
      cwd: x.deps.workspaceRoot,
      writerRunId: 'error-writer',
    })
    expect(await session.hooks.beforeStep({ turn: 1, step: 1, depth: 0 })).toEqual({
      block: true,
      reason: 'E_EVENT_NAMESPACE',
    })
  } finally {
    await a.rollback.unwind()
  }
})

it('a narrowed capability ceiling keeps the refused builtin off the rows, and Host still boots', async () => {
  // `projections: true` narrows policy.capabilityCeiling, which refuses agnes/tools-web's declared
  // `network.publicRead`. Rowifying that id must NOT turn "one extension fails to load" into
  // "Host does not exist": admission is preflighted before a row is built, and an id that cannot be
  // admitted keeps the pre-row managed.load supply so the failure is still audited exactly once.
  const x = await setup(true)
  const a = await assemble(x.profile, x.deps)
  try {
    const web = a.extHost.status().find((e) => e.id === 'agnes/tools-web')
    expect(web).toBeUndefined()
    const events = (x.deps.audit as AuditSink & { events: AuditEvent[] }).events
    expect(
      events.filter(
        (e) =>
          e.kind === 'extension.failed' &&
          (e.detail as { id?: string } | undefined)?.id === 'agnes/tools-web',
      ),
    ).toHaveLength(1)
    expect(a.extensionRows.current().map((r) => r.id)).not.toContain('ext:agnes/tools-web')
    expect(a.ordinaryConvergence().rows.find((r) => r.id === 'ext:agnes/tools-web')).toBeUndefined()
    // The admitted siblings still get their rows, so this is not a blanket opt-out.
    expect(a.extensionRows.current().map((r) => r.id)).toContain('ext:agnes/tools-core')
  } finally {
    await a.rollback.unwind()
  }
})
