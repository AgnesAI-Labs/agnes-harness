import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'
import {
  BUNDLED_EXAMPLES,
  BUNDLED_HELPERS,
  bundledExampleSource,
  bundledPluginSource,
  bundledPluginSourceRoot,
  DEFAULT_ENABLED_BUNDLED_PACKAGES,
  OPTIONAL_BUNDLED_PACKAGES,
} from '../src/bundled-plugin-source.js'
import { emptyLock, readLock, writeLock } from '../src/lockfile.js'
import { createPackageManager } from '../src/manager.js'
import { fetchSource, hashDirectory, parseSource } from '../src/sources.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-bundled-helper-'))
  roots.push(root)
  return root
}

it('keeps the optional catalogue limited to shipped payloads without reserving ordinary workspace sources', () => {
  expect(OPTIONAL_BUNDLED_PACKAGES.map((item) => item.name)).toEqual(['jev-loop'])
  expect(bundledPluginSource('file:./bundled-plugins/fixture-optional')).toBeUndefined()
  expect(bundledPluginSourceRoot('file:./bundled-plugins/fixture-optional')).toBeUndefined()
})
it.each([...DEFAULT_ENABLED_BUNDLED_PACKAGES, ...OPTIONAL_BUNDLED_PACKAGES])(
  'uses $id runtime payload instead of workspace impostor without network commands',
  async (helper) => {
    const cwd = fixture()
    const impostor = join(cwd, 'bundled-plugins', helper.name)
    mkdirSync(impostor, { recursive: true })
    writeFileSync(join(impostor, 'package.json'), JSON.stringify({ name: 'impostor', version: '9.9.9' }))
    const exec = vi.fn(async () => {
      throw new Error('Network/command forbidden')
    })
    const into = join(cwd, 'stage')
    const fetched = await fetchSource(parseSource(helper.ref), into, { cwd, exec })
    const metadata = JSON.parse(readFileSync(join(into, 'package.json'), 'utf8'))
    expect(metadata.name).toBe(helper.id)
    expect(metadata.version).toBe(helper.version)
    expect(metadata.version).not.toBe('0.0.0')
    {
      // An offline runtime payload must carry domain dependencies; only public Host SDKs are external.
      const compiled = await build({
        entryPoints: [
          join(into, typeof metadata.exports === 'string' ? metadata.exports : metadata.exports['.']),
        ],
        bundle: true,
        platform: 'node',
        format: 'esm',
        external: Object.keys(metadata.agnes.hostProvidedExternals ?? {}),
        write: false,
      })
      expect(compiled.outputFiles[0]?.contents.byteLength).toBeGreaterThan(0)
    }
    const source = bundledPluginSource(helper.ref)
    if (!source) throw new Error('Missing bundled source')
    expect(fetched.integrity).toBe(hashDirectory(join(source.root, source.path)))
    expect(exec).not.toHaveBeenCalled()
    expect(bundledPluginSource('file:./ordinary')).toBeUndefined()
    expect(bundledPluginSource('file:./bundled-plugins/plugin-helper/../impostor')).toBeUndefined()
    expect(bundledPluginSourceRoot('file:./ordinary')).toBeUndefined()
    if (helper.name === 'skill-helper') expect(existsSync(join(into, 'src', 'sources.mjs'))).toBe(true)
  },
)
it.each([...BUNDLED_HELPERS, ...OPTIONAL_BUNDLED_PACKAGES])(
  'inspects and installs $id offline without automatic trust or activation',
  async (helper) => {
    const root = fixture(),
      profile = join(root, 'profiles', 'local-dev')
    mkdirSync(profile, { recursive: true })
    writeLock(profile, {
      ...emptyLock('local-dev', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
          name,
          { provider: 'local' },
        ]),
      ),
      policySnapshot: {
        capabilityCeiling: ['tools', 'ui', 'hooks', 'managedServices', 'services', 'store', 'streams'],
        workspacePackages: 'require-project-trust',
      },
    })
    const exec = vi.fn(async () => {
      throw new Error('Network forbidden')
    })
    const manager = createPackageManager({ dataDir: root, cwd: root, agnesVersion: '0.1.0', exec })
    const preview = await manager.inspect(profile, parseSource(helper.ref))
    expect(preview).toMatchObject({ id: helper.id, blockers: [] })
    const installed = await manager.add(profile, helper.ref)
    expect(installed.state).toMatchObject({ trusted: null, enabled: false })
    expect(
      readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages[helper.id],
    ).toBeDefined()
    expect(exec).not.toHaveBeenCalled()
  },
)

it.each([
  { family: 'loops', name: 'dag-loop', id: '@agnes-example/dag-loop' },
  { family: 'community', name: 'tool-panel', id: '@community/tool-panel' },
])('fetches bundled $family/$name offline without using a workspace impostor', async (expected) => {
  const root = fixture()
  const example = BUNDLED_EXAMPLES.find(
    (item) => item.family === expected.family && item.name === expected.name,
  )!
  const impostor = join(root, 'bundled-examples', example.family, example.name)
  mkdirSync(impostor, { recursive: true })
  writeFileSync(join(impostor, 'package.json'), JSON.stringify({ name: 'impostor', version: '9.9.9' }))
  const exec = vi.fn(async () => {
    throw new Error('Network forbidden')
  })
  const into = join(root, 'stage')
  await fetchSource(parseSource(example.ref), into, { cwd: root, exec })
  const metadata = JSON.parse(readFileSync(join(into, 'package.json'), 'utf8'))
  expect(metadata.name).toBe(expected.id)
  expect(bundledExampleSource('file:./bundled-examples/loops/dag-loop/../../impostor')).toBeUndefined()
  expect(exec).not.toHaveBeenCalled()
})

it('generates an executable tool plugin using the current owned registration port', async () => {
  type Tool = import('@agnes/extension-api').ToolDef
  const registered = new Map<string, Tool>()
  const tools = {
    register: (tool: Tool) => {
      registered.set(tool.name, tool)
    },
  }
  const { pluginHelper } = await import(
    new URL('../bundled-plugins/plugin-helper/index.mjs', import.meta.url).href
  )
  pluginHelper.apply({ tools })
  const install = registered.get('plugin_helper_install')!
  for (const output of [
    'not ok 1 - three-day warning\n' + 'x'.repeat(20000),
    'E_TOOLDEF_META: meta.replay: safe requires isReadOnly',
    'Test port not configured; supply options.context',
  ]) {
    for (const state of ['failed', 'passed']) {
      const failure = await install.execute({ action: 'test', proposalId: 'synthetic-candidate' }, {
        signal: new AbortController().signal,
        session: { depth: 0 },
        pluginManage: {
          request: async () => ({
            candidateId: 'synthetic-candidate',
            candidateHash: 'sha256-reviewed',
            state,
            tests: { state, count: 1, output },
          }),
        },
      } as never)
      const modelText = JSON.stringify(failure.content)
      if (state === 'failed') {
        expect(modelText).toContain(output.split('\n')[0])
        expect(modelText.length).toBeLessThan(10000)
        if (!output.startsWith('not ok')) {
          expect(modelText).toContain('Repair hint')
          expect(modelText).toContain("replay: 'never'")
          expect(modelText).toContain("'default' is invalid")
          expect(modelText).toContain('statefulFs')
          expect(modelText).toContain('BOTH survive')
        } else expect(modelText).not.toContain('Repair hint')
      } else {
        expect(modelText).not.toContain(output.split('\n')[0])
        expect(modelText).not.toContain('Repair hint')
      }
    }
  }
  const guide = registered.get('plugin_helper_guide')!
  // The guide is readable even when the invocation has no authoring capability.
  for (const context of [undefined, null, {}])
    for (const kind of ['tool', 'skill', 'skin'])
      expect(await guide.execute({ kind }, context as never)).toMatchObject({
        structured: { authoringCapability: 'unavailable-host-capability' },
      })
  const request = vi.fn(async () => {
    throw new Error('The guide must not request an operation')
  })
  const result = await guide.execute({ kind: 'tool' }, {
    signal: new AbortController().signal,
    session: { depth: 0 },
    pluginManage: { request },
  } as never)
  expect(result).toMatchObject({
    structured: { authoringCapability: 'supplied-authorization-checked-per-call' },
  })
  expect(request).not.toHaveBeenCalled()
  const text = result.content.find((part) => part.type === 'text')
  if (!text || text.type !== 'text') throw new Error('guide returned no text')
  const data = JSON.parse(text.text) as {
    apiVersion: string
    authoringPath: string
    files: { path: string; content: string }[]
  }
  expect(data.apiVersion).toBe('5.0.0')
  for (const rule of ['interface ToolMeta', "'default' is invalid", 'statefulFs', 'BOTH survive'])
    expect(data.authoringPath).toContain(rule)
  const source = data.files.find((file) => file.path === 'index.mjs')!
  const { main } = await import(`data:text/javascript,${encodeURIComponent(source.content)}`)
  const packageDir = fixture()
  const manifest = data.files.find((file) => file.path === 'package.json')
  if (!manifest) throw new Error('guide returned no package manifest')
  writeFileSync(join(packageDir, 'package.json'), manifest.content)
  // Load the public test SDK at runtime: Host depends on this package, so its testkit must not
  // become a build reference back to Host. The root test workspace supplies the SDK.
  const authorSdk = '@agnes/host/author-testkit'
  const { createPluginTestHost } = await import(authorSdk)
  const host = await createPluginTestHost(main, { packageDir })
  try {
    expect(await host.invoke('my_text_stats', { text: 'two words' })).toMatchObject({
      structured: { characters: 9, words: 2 },
    })
  } finally {
    await host.dispose()
  }
})

it('installs the community deliverables replacement in a throwaway home and preserves checked enable/disable/uninstall lifecycle', async () => {
  const root = fixture(),
    profile = join(root, 'profiles', 'local-dev')
  mkdirSync(profile, { recursive: true })
  writeLock(profile, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
      ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
        name,
        { provider: 'local' },
      ]),
    ),
    policySnapshot: { capabilityCeiling: ['ui'], workspacePackages: 'require-project-trust' },
  })
  const exec = vi.fn(async () => {
    throw new Error('Network forbidden')
  })
  const manager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    exec,
    references: async () => [],
  })
  const source = parseSource(
    `file:${fileURLToPath(new URL('../../../examples/community/deliverables-gallery', import.meta.url))
      .split(sep)
      .join('/')}`,
  )
  const review = await manager.inspect(profile, source)
  expect(review).toMatchObject({ id: '@community/deliverables-gallery', blockers: [] })
  await manager.install(profile, source, { expectedIntegrity: review.integrity })
  const installed = (await manager.inventory(profile)).packages.find((row) => row.id === review.id)!
  await manager.trust(profile, review.id, {
    integrity: installed.entry.integrity,
    capabilityHash: installed.capabilityHash,
  })
  await manager.setEnabled(profile, review.id, true)
  const restarted = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    exec,
    references: async () => [],
  })
  expect((await restarted.inventory(profile)).packages.find((row) => row.id === review.id)).toMatchObject({
    enabled: true,
    trusted: true,
  })
  await restarted.setEnabled(profile, review.id, false)
  await restarted.remove(profile, review.id)
  expect((await restarted.inventory(profile)).packages.some((row) => row.id === review.id)).toBe(false)
  expect(exec).not.toHaveBeenCalled()
})
