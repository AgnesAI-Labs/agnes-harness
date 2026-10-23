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
import { zip } from './fixtures/document-reader.js'

const purpose = {
  displayName: 'File search',
  summary: 'Find project text.',
  description: 'Find text in readable project files.',
  locales: { 'zh-CN': { displayName: '文件搜索', summary: '检索项目文本。' } },
}

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
let root: string, profile: string, sourceDir: string
const source = parseSource('file:./candidate')
const seamNames = ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals']
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
    agnes: {
      plugins: [{ apiRange: '^5.0.0', export: 'main', id: 'ext:acme/pkg-a/main', runtime: 'in-process' }],
    },
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
    seams: Object.fromEntries(seamNames.map((k) => [k, { provider: 'local' }])),
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it.each(['file', 'git'] as const)(
  'inspects and installs a valid %s plugin without executing code or granting trust',
  async (kind) => {
    writeFileSync(join(sourceDir, 'index.ts'), `throw new Error('must not run')`)
    pkg({
      scripts: { postinstall: 'exit 99' },
      agnes: { metadata: purpose, plugins: [{ apiRange: '^5.0.0', export: 'main', metadata: purpose }] },
    })
    const before = lockBytes(),
      phases: number[] = []
    const commit = 'a'.repeat(40)
    const candidate = kind === 'git' ? parseSource(`git:https://example.com/plugin.git#${commit}`) : source
    const m = manager({
        exec: async (_command, args) => {
          if (args.includes('checkout')) cpSync(sourceDir, args[args.indexOf('-C') + 1]!, { recursive: true })
          return { stdout: args.includes('rev-parse') ? commit : '' }
        },
      }),
      preview = await m.inspect(profile, candidate, { onProgress: (p) => phases.push(p.percent) })
    expect(lockBytes()).toBe(before)
    expect(phases).toEqual([0, 50, 100])
    clean()
    expect(preview).toMatchObject({
      id: 'acme/pkg-a',
      provenance: { signatureVerified: false },
      blockers: [],
      contributions: [],
    })
    const entry = await m.install(profile, candidate, { expectedIntegrity: preview.integrity })
    expect(entry.state).toMatchObject({ trusted: null, enabled: false })
    expect(entry.treeIntegrity).toBe(
      hashDirectory(packageDir(root, 'local-dev', preview.id), { exclude: [] }),
    )
    expect(entry.contributions).toEqual(preview.contributions)
    expect(preview.presentation?.rows).toEqual([
      { id: 'ext:acme/pkg-a/main', metadata: purpose, settings: false },
    ])
    expect(preview.metadata).toEqual(purpose)
    expect(entry.metadata).toEqual(purpose)
    expect(
      readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages[preview.id]?.metadata,
    ).toEqual(purpose)
    clean()
  },
)
it('recognizes the static agnes.plugins declaration without importing plugin code', async () => {
  writeFileSync(join(sourceDir, 'index.mjs'), `throw new Error('plugin code must not run during inspect')`)
  pkg({
    exports: './index.mjs',
    agnes: {
      plugins: [{ apiRange: '^5.0.0', export: 'main', runtime: 'in-process', config: { greeting: 'hello' } }],
    },
  })

  const preview = await manager().inspect(profile, source)
  expect(preview.blockers).toEqual([])
  expect(preview.contributions).toEqual([])
})

it('refuses invalid present package purpose without installing or executing it', async () => {
  pkg({
    agnes: {
      metadata: { ...purpose, docsUrl: 'http://example.org/' },
      plugins: [{ apiRange: '^5.0.0', export: 'main' }],
    },
  })
  const before = lockBytes()
  await expect(manager().inspect(profile, source)).rejects.toMatchObject({
    detail: { reason: 'plugin-metadata' },
  })
  expect(lockBytes()).toBe(before)
})

it('rejects a package that declares both executable loading formats', async () => {
  pkg({ agnes: { plugins: [{ apiRange: '^5.0.0', export: 'main' }], extensions: [] } })
  await expect(manager().inspect(profile, source)).rejects.toMatchObject({
    detail: { reason: 'legacy-extension-format' },
  })
})

it('rejects package-authored web rows with a stable reserved-prefix reason', async () => {
  writeFileSync(join(sourceDir, 'index.mjs'), 'export default () => ({})\n')
  pkg({
    exports: './index.mjs',
    agnes: { plugins: [{ apiRange: '^5.0.0', export: 'panel', id: 'web:@victim/panel' }] },
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
it.each(['acme/pkg-a', 'constructor'])(
  'never replaces an installed package %s through install',
  async (name) => {
    // Lock membership is own-property only: "constructor" is a valid id, not Object.prototype's.
    pkg({ name, dependencies: { 'acme/dependency': '^1.0' } })
    const m = manager(),
      p = await m.inspect(profile, source)
    expect(p.id).toBe(name)
    await m.install(profile, source, { expectedIntegrity: p.integrity })
    const before = lockBytes()
    await expect(m.install(profile, source, { expectedIntegrity: p.integrity })).rejects.toThrow('use update')
    expect(lockBytes()).toBe(before)
    clean()
  },
)
it('reads the non-executable contribution kinds and detects grant/dependency differences', async () => {
  mkdirSync(join(sourceDir, 'dist'))
  writeFileSync(join(sourceDir, 'dist', 'server.mjs'), 'throw Error()')
  const contributions = [
    { kind: 'seam', id: 'acme/seam', path: './index.ts', apiRange: '^5.0.0', provides: ['billing'] },
    { kind: 'provider', id: 'acme/provider', path: './index.ts', apiRange: '^5.0.0' },
    { kind: 'runtime', id: 'acme/runtime', path: './index.ts', apiRange: '^5.0.0' },
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
          apiRange: '^5.0.0',
          artifact: { kind: 'node', entry: './dist/server.mjs' },
          healthPath: '/health',
          requires: { services: [{ extension: 'acme/pkg-a', name: 'status', range: '^1.0' }] },
        },
      ],
    },
  })
  const m = manager()
  const p = await m.inspect(profile, source)
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
  expect(p.warnings.some((warning) => warning.code === 'dependency-change')).toBe(false)
  await m.install(profile, source, { expectedIntegrity: p.integrity })
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'))
  manifest.dependencies['acme/dependency'] = '^2.0'
  json(join(sourceDir, 'package.json'), manifest)
  const next = await m.inspect(profile, source)
  expect(next.capabilityDiff.dependenciesAdded).toEqual(['acme/dependency'])
  expect(next.warnings.some((warning) => warning.code === 'dependency-change')).toBe(true)
})
it('rejects bundled legacy manifests even when the package does not declare plugins', async () => {
  cpSync(join(fixtures, 'pkg-a'), join(sourceDir, 'bundle'), { recursive: true })
  const file = join(sourceDir, 'bundle', 'agnes.extension.json')
  const manifest = {
    id: 'acme/pkg-a',
    version: '1.0.0',
    apiRange: '^5.0.0',
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
  { kinds: ['tool'] },
  { metadata: { ...purpose, category: 'tools' } },
  { metadata: { ...purpose, launches: [] } },
  { plugins: [{ apiRange: '^5.0.0', export: 'main', metadata: { ...purpose, category: 'tools' } }] },
])('refuses retired metadata with a clean-home hint %#', async (agnes) => {
  pkg({ agnes })
  await expect(manager().inspect(profile, source)).rejects.toThrow(/Retired.*clean home/)
  clean()
})
it.each([
  { agnes: { unknown: [] } },
  { agnes: { provides: ['invalid'], plugins: [{ apiRange: '^5.0.0', export: 'main' }] } },
  { agnes: { contributions: [{ kind: 'mystery', id: 'acme/x' }] } },
  {
    agnes: {
      contributions: [
        { kind: 'extension', id: 'acme/x', path: './index.ts', apiRange: '^5.0.0', capabilities: {} },
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
it.each([
  [{ export: 'main' }, 'plugin-api-range-required'],
  [{ export: 'main', apiRange: '^99.0.0' }, 'plugin-api-range-incompatible'],
])('refuses ordinary plugin %j before install with an actionable API hint', async (plugin, reason) => {
  pkg({ agnes: { plugins: [plugin] } })
  const before = lockBytes()
  const expected = { code: 'E_PACKAGE_BLOCKED', detail: { reason, hint: expect.stringMatching(/range/i) } }
  await expect(manager().inspect(profile, source)).rejects.toMatchObject(expected)
  await expect(
    manager().install(profile, source, { expectedIntegrity: hashDirectory(sourceDir) }),
  ).rejects.toMatchObject(expected)
  expect(lockBytes()).toBe(before)
  expect(existsSync(packageDir(root, 'local-dev', 'acme/pkg-a'))).toBe(false)
  clean()
})
it('refuses non-plugin packages and legacy dynamic metadata with a specific reason', async () => {
  pkg({ main: 'index.ts', exports: undefined, agnes: undefined })
  await expect(manager().inspect(profile, source)).rejects.toMatchObject({
    code: 'E_PACKAGE_SOURCE',
    detail: { reason: 'static-declaration-required' },
  })
  await expect(
    manager().install(profile, source, { expectedIntegrity: hashDirectory(sourceDir) }),
  ).rejects.toMatchObject({
    code: 'E_PACKAGE_SOURCE',
    detail: { reason: 'static-declaration-required' },
  })
  json(join(sourceDir, 'agnes.extension.json'), {
    id: 'acme/pkg-a',
    version: '1.0.0',
    apiRange: '^5.0.0',
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
  pkg({
    agnes: {
      plugins: [{ apiRange: '^5.0.0', export: 'main', id: 'ext:acme/pkg-a/main', config: { mode: 'next' } }],
    },
  })
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
      ...(field === 'integrity' ? { detail: { reason: 'adapter-integrity' } } : {}),
    })
    clean()
  },
)
it.each([false, true])(
  'refuses an archive carrying node_modules for that reason (carries: %s)',
  async (carries) => {
    // Non-npm fetch digests skip node_modules, .git and fixtures/out, so such a tree can never verify;
    // that is not an adapter fault.
    const files = ['package.json', 'index.ts'].map((name) => ({
      name,
      data: readFileSync(join(sourceDir, name)),
    }))
    if (carries) files.push({ name: 'node_modules/dep/index.js', data: Buffer.from('module.exports = 1\n') })
    writeFileSync(join(root, 'candidate.zip'), zip(files))
    const inspected = manager().inspect(profile, parseSource('file:./candidate.zip'))
    if (carries)
      await expect(inspected).rejects.toMatchObject({
        code: 'E_PACKAGE_STATE',
        detail: { reason: 'excluded-directory' },
      })
    else await expect(inspected).resolves.toMatchObject({ id: 'acme/pkg-a' })
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
          apiRange: '^5.0.0',
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

it('projects declared package kinds through preview and verified installed inventory', async () => {
  pkg({ agnes: { provides: ['loop', 'ui'], plugins: [{ apiRange: '^5.0.0', export: 'main' }] } })
  const instance = manager()
  const preview = await instance.inspect(profile, source)
  expect(preview.provides).toEqual(['loop', 'ui'])
  await instance.install(profile, source, { expectedIntegrity: preview.integrity })
  const inventory = await instance.inventory(profile)
  expect(inventory.packages.find((item) => item.id === 'acme/pkg-a')?.provides).toEqual(['loop', 'ui'])
})

it('installs a static bundle package and exposes its kind without executing an entry', async () => {
  const launch = { title: { en: 'Work' }, description: { en: 'Work' }, preset: 'standard' }
  pkg({
    exports: undefined,
    agnes: {
      provides: ['bundle'],
      bundles: { base: { profile: { toolPolicy: { readOnly: true } }, launch } },
    },
  })
  writeFileSync(join(sourceDir, 'index.ts'), "throw new Error('bundle code must not run')")
  const instance = manager()
  const preview = await instance.inspect(profile, source)
  expect(preview.provides).toEqual(['bundle'])
  expect(preview.preflight).toMatchObject({
    level: 'deployment-dependent',
    reasons: ['launch-preset-definition-required:standard'],
  })
  expect(preview.blockers).toEqual([])
  await instance.install(profile, source, { expectedIntegrity: preview.integrity })
  expect(
    (await instance.inventory(profile)).packages.find((item) => item.id === 'acme/pkg-a')?.provides,
  ).toEqual(['bundle'])
  pkg({
    exports: undefined,
    agnes: {
      provides: ['bundle'],
      bundles: {
        base: {
          launch: { ...launch, preset: 'a' },
          presets: { a: { name: 'a', extends: 'b' }, b: { name: 'b', extends: 'a' } },
        },
      },
    },
  })
  const refusal = {
    code: 'E_PACKAGE_STATE',
    detail: { reason: expect.stringContaining('preset extends cycle') },
  }
  await expect(instance.inspect(profile, source)).rejects.toMatchObject(refusal)
  await expect(
    instance.install(profile, source, { expectedIntegrity: hashDirectory(sourceDir) }),
  ).rejects.toMatchObject(refusal)
})
