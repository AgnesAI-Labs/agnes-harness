import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
import { createSession } from '../../src/session.js'
import { SessionWorkspaceRuntimeTable } from '../../src/session-workspace-runtime.js'
import { WorkspaceBindingAuthority } from '../../src/workspace-authority.js'

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
    // The real Base sandbox serves only workspace-bound sessions, so open the session the way Host
    // does: through an accepted binding and its workspace runtime.
    const sessionKey = 't6-3-real'
    const binding = new WorkspaceBindingAuthority().accept(
      {
        version: 1,
        sessionKey,
        workspaceId: 'a'.repeat(64),
        revision: 1,
        canonicalRoot: realpathSync(x.deps.workspaceRoot),
      },
      sessionKey,
    )
    const table = new SessionWorkspaceRuntimeTable()
    a.rollback.push('test-workspace-runtime', () => table.closeAll())
    const runtime = await table.open(binding, () => a.openWorkspaceRuntime(binding))
    const session = await createSession(x.profile, a, { key: sessionKey, binding }, undefined, {
      runtime,
      lifecycle: table.lifecycle(sessionKey),
      children: table,
      invocation: table.invocation(sessionKey),
    })
    try {
      const result = await session.hooks.beforeStep({ turn: 1, step: 1, depth: 0 })
      expect(result).toMatchObject({ block: true, reason: 'isolated package' })
    } finally {
      await session.close()
    }
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
