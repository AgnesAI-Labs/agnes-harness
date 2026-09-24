import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createPackageManager,
  emptyLock,
  fetchSource,
  hashDirectory,
  type ManagerOptions,
  type PackageSourceAdapter,
  packageDir,
  parseSource,
  readLock,
  writeLock,
} from '../src/index.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
let root: string, profile: string, sourceDir: string
const source = parseSource('file:./candidate')
const seamNames = [
  'approval',
  'checkpoint',
  'ledger',
  'sandbox',
  'verifier',
  'repair',
  'artifacts',
  'principals',
  'platform',
  'harness',
]
function manager(options: Partial<ManagerOptions> = {}) {
  return createPackageManager({ dataDir: root, agnesVersion: '0.1.0', cwd: root, ...options })
}
function json(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value))
}
function pkg(extra: Record<string, unknown> = {}) {
  json(join(sourceDir, 'package.json'), {
    name: 'acme/pkg-a',
    version: '1.0.0',
    license: 'MIT',
    exports: './index.ts',
    agnes: { plugins: [{ export: 'main', id: 'ext:acme/pkg-a/main', runtime: 'in-process' }] },
    ...extra,
  })
}
function clean() {
  const dir = join(profile, 'packages')
  expect(existsSync(dir) ? readdirSync(dir).filter((x) => x.startsWith('.')) : []).toEqual([])
}
function lockBytes() {
  return readFileSync(join(profile, 'agnes-lock.json'), 'utf8')
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-inspect-'))
  profile = join(root, 'profiles', 'local-dev')
  mkdirSync(profile, { recursive: true })
  sourceDir = join(root, 'candidate')
  cpSync(join(fixtures, 'pkg-a'), sourceDir, { recursive: true })
  pkg()
  writeLock(profile, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(seamNames.map((k) => [k, '@agnes/base'])),
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('previews without importing code or writing lock, then installs only disabled/untrusted with a checked tree', async () => {
  writeFileSync(join(sourceDir, 'index.ts'), `throw new Error('must not run')`)
  pkg({ scripts: { postinstall: 'exit 99' } })
  const before = lockBytes(),
    phases: number[] = []
  const m = manager(),
    preview = await m.inspect(profile, source, { onProgress: (p) => phases.push(p.percent) })
  expect(lockBytes()).toBe(before)
  expect(phases).toEqual([0, 50, 100])
  clean()
  expect(preview).toMatchObject({
    id: 'acme/pkg-a',
    provenance: { signatureVerified: false },
    blockers: [],
    contributions: [],
  })
  const entry = await m.install(profile, source, { expectedIntegrity: preview.integrity })
  expect(entry.state).toMatchObject({ trusted: null, enabled: false })
  expect(entry.treeIntegrity).toBe(hashDirectory(packageDir(root, 'local-dev', preview.id), { exclude: [] }))
  expect(entry.contributions).toEqual(preview.contributions)
  clean()
})
it('recognizes the static agnes.plugins declaration without importing plugin code', async () => {
  writeFileSync(join(sourceDir, 'index.mjs'), `throw new Error('plugin code must not run during inspect')`)
  pkg({
    exports: './index.mjs',
    agnes: { plugins: [{ export: 'main', runtime: 'in-process', config: { greeting: 'hello' } }] },
  })

  const preview = await manager().inspect(profile, source)
  expect(preview.blockers).toEqual([])
  expect(preview.contributions).toEqual([])
})

it('rejects a package that declares both executable loading formats', async () => {
  pkg({ agnes: { plugins: [{ export: 'main' }], extensions: [] } })
  await expect(manager().inspect(profile, source)).rejects.toMatchObject({
    detail: { reason: 'legacy-extension-format' },
  })
})

it('rejects package-authored web rows with a stable reserved-prefix reason', async () => {
  writeFileSync(join(sourceDir, 'index.mjs'), 'export default () => ({})\n')
  pkg({
    exports: './index.mjs',
    agnes: { plugins: [{ export: 'panel', id: 'web:@victim/panel' }] },
  })
  await expect(manager().inspect(profile, source)).rejects.toMatchObject({
    code: 'E_PACKAGE_STATE',
    detail: { reason: 'reserved-row-id', prefix: 'web:' },
  })
})
it('rejects stale previews without any lock/store change', async () => {
  const m = manager(),
    preview = await m.inspect(profile, source),
    before = lockBytes()
  writeFileSync(join(sourceDir, 'index.ts'), 'changed')
  await expect(m.install(profile, source, { expectedIntegrity: preview.integrity })).rejects.toMatchObject({
    code: 'E_PACKAGE_PREVIEW_STALE',
  })
  expect(lockBytes()).toBe(before)
  expect(existsSync(packageDir(root, 'local-dev', preview.id))).toBe(false)
  clean()
})
it('never replaces an installed package through install', async () => {
  const m = manager(),
    p = await m.inspect(profile, source)
  await m.install(profile, source, { expectedIntegrity: p.integrity })
  const before = lockBytes()
  await expect(m.install(profile, source, { expectedIntegrity: p.integrity })).rejects.toThrow('use update')
  expect(lockBytes()).toBe(before)
  clean()
})
it('reads the non-executable contribution kinds and detects grant/dependency differences', async () => {
  mkdirSync(join(sourceDir, 'dist'))
  writeFileSync(join(sourceDir, 'dist', 'server.mjs'), 'throw Error()')
  const contributions = [
    { kind: 'seam', id: 'acme/seam', path: './index.ts', apiRange: '^1.0', provides: ['ledger'] },
    { kind: 'provider', id: 'acme/provider', path: './index.ts', apiRange: '^1.0' },
    { kind: 'runtime', id: 'acme/runtime', path: './index.ts', apiRange: '^1.0' },
    { kind: 'skill', id: 'acme/skill', path: './index.ts' },
    { kind: 'preset', id: 'acme/preset', path: './index.ts' },
  ]
  pkg({
    dependencies: { 'acme/dependency': '^1.0' },
    agnes: {
      contributions,
      surfaces: [
        {
          id: 'web',
          apiRange: '^1.0',
          artifact: { kind: 'node', entry: './dist/server.mjs' },
          healthPath: '/health',
          requires: { services: [{ extension: 'acme/pkg-a', name: 'status', range: '^1.0' }] },
        },
      ],
    },
  })
  const p = await manager().inspect(profile, source)
  expect(p.contributions.map((c) => c.kind)).toEqual([
    'preset',
    'provider',
    'runtime',
    'seam',
    'skill',
    'surface',
  ])
  expect(p.capabilityDiff.dependenciesAdded).toEqual(['acme/dependency'])
  expect(p.capabilityDiff.serviceGrantsAdded).toHaveLength(1)
  expect(p.blockers).toEqual([])
})
it('rejects bundled legacy manifests even when the package does not declare plugins', async () => {
  cpSync(join(fixtures, 'pkg-a'), join(sourceDir, 'bundle'), { recursive: true })
  const file = join(sourceDir, 'bundle', 'agnes.extension.json')
  const manifest = {
    id: 'acme/pkg-a',
    version: '1.0.0',
    apiRange: '^1.0',
    entry: './index.ts',
    capabilities: {},
  }
  manifest.id = 'acme/bundled'
  json(file, manifest)
  pkg({ agnes: { extensions: ['bundle'] } })
  await expect(manager().inspect(profile, source)).rejects.toMatchObject({
    detail: { reason: 'legacy-extension-format' },
  })
  clean()
})
it.each([
  { agnes: { unknown: [] } },
  { agnes: { contributions: [{ kind: 'mystery', id: 'acme/x' }] } },
  {
    agnes: {
      contributions: [
        { kind: 'extension', id: 'acme/x', path: './index.ts', apiRange: '^1.0', capabilities: {} },
      ],
    },
  },
  { agnes: { extensions: ['../candidate'] } },
  { agnes: { contributions: [{ kind: 'skill', id: 'acme/x', path: '../escape' }] } },
  { agnes: { contributions: [{ kind: 'skill', id: 'acme/x', path: './missing' }] } },
])('refuses malformed, unknown or escaped static metadata %#', async (extra) => {
  pkg(extra)
  await expect(manager().inspect(profile, source)).rejects.toMatchObject({ code: 'E_PACKAGE_STATE' })
  clean()
})
it('returns blockers for legacy dynamic-only packages and policy/API incompatibility', async () => {
  pkg({ main: 'index.ts', exports: undefined, agnes: undefined })
  const p = await manager().inspect(profile, source)
  expect(p.blockers).toEqual([{ code: 'unknown-contribution', references: ['static-declaration-required'] }])
  await expect(manager().install(profile, source, { expectedIntegrity: p.integrity })).rejects.toMatchObject({
    code: 'E_PACKAGE_BLOCKED',
  })
  json(join(sourceDir, 'agnes.extension.json'), {
    id: 'acme/pkg-a',
    version: '1.0.0',
    apiRange: '^1.0',
    entry: './index.ts',
    capabilities: {},
  })
  const f = join(sourceDir, 'agnes.extension.json'),
    m = JSON.parse(readFileSync(f, 'utf8'))
  m.apiRange = '^99.0'
  json(f, m)
  await expect(manager({ ceiling: [] }).inspect(profile, source)).rejects.toMatchObject({
    detail: { reason: 'legacy-extension-format' },
  })
  clean()
})
it('does not report a plugin config update as an extension capability expansion', async () => {
  const m = manager(),
    preview = await m.inspect(profile, source)
  await m.install(profile, source, { expectedIntegrity: preview.integrity })
  expect((await m.inspect(profile, source)).capabilityDiff.added).toEqual([])
  pkg({ agnes: { plugins: [{ export: 'main', id: 'ext:acme/pkg-a/main', config: { mode: 'next' } }] } })
  const next = await m.inspect(profile, source)
  expect(next.capabilityDiff.added).toEqual([])
  expect(next.capabilityDiff.removed).toEqual([])
})
it('rejects oversized JSON and symlink before any installation', async () => {
  const before = lockBytes()
  writeFileSync(join(sourceDir, 'package.json'), ' '.repeat(1048577))
  await expect(manager().inspect(profile, source)).rejects.toThrow('no readable package.json')
  clean()
  pkg()
  const outside = join(root, 'outside-directory')
  mkdirSync(outside)
  writeFileSync(join(outside, 'marker.txt'), 'untouched')
  const alias = join(sourceDir, 'outside')
  // guards-allow-platform: the fixture points to a real directory on either platform.
  symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(realpathSync(alias)).toBe(realpathSync(outside))
  await expect(manager().inspect(profile, source)).rejects.toThrow('symbolic link')
  expect(readFileSync(join(outside, 'marker.txt'), 'utf8')).toBe('untouched')
  expect(lockBytes()).toBe(before)
  clean()
})
it.each(['fetching', 'inspecting', 'committing'] as const)(
  'cancels at %s without partial installation',
  async (phase) => {
    const m = manager(),
      p = await m.inspect(profile, source),
      before = lockBytes(),
      abort = new AbortController()
    await expect(
      m.install(profile, source, {
        expectedIntegrity: p.integrity,
        signal: abort.signal,
        onProgress: (p) => {
          if (p.phase === phase) abort.abort()
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PACKAGE_CANCELLED' })
    expect(lockBytes()).toBe(before)
    expect(existsSync(packageDir(root, 'local-dev', 'acme/pkg-a'))).toBe(false)
    clean()
  },
)
it('passes cancellation to an actual injected adapter and waits for cleanup', async () => {
  const controller = new AbortController(),
    completed = vi.fn()
  const adapter: PackageSourceAdapter = {
    type: 'file',
    async fetch(_source, into, { signal }) {
      mkdirSync(into)
      writeFileSync(join(into, 'partial'), 'partial')
      await new Promise<void>((resolve) => {
        signal?.addEventListener(
          'abort',
          () => {
            setTimeout(() => {
              completed()
              resolve()
            }, 5)
          },
          { once: true },
        )
        controller.abort()
      })
      throw Error('adapter cancelled')
    },
  }
  await expect(
    manager({ sourceAdapters: [adapter] }).inspect(profile, source, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_CANCELLED' })
  expect(completed).toHaveBeenCalledOnce()
  clean()
})
it.each(['version', 'dependencies', 'integrity', 'license'] as const)(
  'rejects adapter %s metadata lies',
  async (field) => {
    const adapter: PackageSourceAdapter = {
      type: 'file',
      async fetch(s, into, options) {
        const f = await fetchSource(s, into, options)
        return { ...f, [field]: field === 'dependencies' ? { 'acme/lie': '1.0.0' } : 'lie' }
      },
    }
    await expect(manager({ sourceAdapters: [adapter] }).inspect(profile, source)).rejects.toMatchObject({
      code: 'E_PACKAGE_STATE',
    })
    clean()
  },
)
it('rejects duplicate adapters and keeps workspace install behind project trust', async () => {
  const adapter: PackageSourceAdapter = { type: 'file', fetch: fetchSource }
  expect(() => manager({ sourceAdapters: [adapter, adapter] })).toThrow('duplicate')
  mkdirSync(join(root, 'extensions'))
  cpSync(sourceDir, join(root, 'extensions', 'pkg'), { recursive: true })
  const ws = parseSource('workspace:extensions/pkg'),
    p = await manager().inspect(profile, ws)
  expect(p.blockers).toContainEqual({ code: 'policy', references: ['use-trust-workspace'] })
  await expect(manager().install(profile, ws, { expectedIntegrity: p.integrity })).rejects.toMatchObject({
    code: 'E_PACKAGE_BLOCKED',
  })
  clean()
})
it('rechecks staging after progress and does not falsely fail an already committed install', async () => {
  const m = manager(),
    p = await m.inspect(profile, source)
  await expect(
    m.install(profile, source, {
      expectedIntegrity: p.integrity,
      onProgress: ({ phase }) => {
        if (phase === 'committing') {
          const stage = readdirSync(join(profile, 'packages')).find((x) => x.startsWith('.stage-'))
          if (!stage) throw Error('stage missing')
          writeFileSync(join(profile, 'packages', stage, 'index.ts'), 'tampered')
        }
      },
    }),
  ).rejects.toThrow('staging changed')
  clean()
  await m.install(profile, source, {
    expectedIntegrity: p.integrity,
    onProgress: ({ phase }) => {
      if (phase === 'completed') throw Error('observer')
    },
  })
  expect(
    readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages['acme/pkg-a'],
  ).toBeDefined()
})

it('rejects duplicate Surface grants with conflicting ranges during inspect', async () => {
  pkg({
    agnes: {
      surfaces: [
        {
          id: 'web',
          apiRange: '^1.0',
          artifact: { kind: 'oci', image: `registry.test/web@sha256:${'0'.repeat(64)}` },
          healthPath: '/health',
          requires: {
            services: [
              { extension: 'acme/pkg-a', name: 'status', range: '^1.0' },
              { extension: 'acme/pkg-a', name: 'status', range: '^2.0' },
            ],
          },
        },
      ],
    },
  })
  await expect(manager().inspect(profile, source)).rejects.toMatchObject({ detail: { reason: 'surface' } })
})
it('rejects custom npm identity different from the exact source', async () => {
  const adapter: PackageSourceAdapter = {
    type: 'npm',
    async fetch(_s, into, options) {
      return fetchSource(source, into, options)
    },
  }
  await expect(
    manager({ sourceAdapters: [adapter] }).inspect(profile, parseSource('npm:other@1.0.0')),
  ).rejects.toMatchObject({ detail: { reason: 'source-identity' } })
})
