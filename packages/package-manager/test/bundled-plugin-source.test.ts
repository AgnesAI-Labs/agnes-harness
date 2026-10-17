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
      policySnapshot: { capabilityCeiling: ['tools', 'ui'], workspacePackages: 'require-project-trust' },
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
    if (helper.id === '@agnes/eval-studio')
      expect(DEFAULT_ENABLED_BUNDLED_PACKAGES.some((item) => item.id === helper.id)).toBe(false)
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
  const guide = registered.get('plugin_helper_guide')!
  const result = await guide.execute({ kind: 'tool' }, {} as never)
  const text = result.content.find((part) => part.type === 'text')
  if (!text || text.type !== 'text') throw new Error('guide returned no text')
  const data = JSON.parse(text.text) as { apiVersion: string; files: { path: string; content: string }[] }
  expect(data.apiVersion).toBe('4.0.0')
  const source = data.files.find((file) => file.path === 'index.mjs')!
  const { main } = await import(`data:text/javascript,${encodeURIComponent(source.content)}`)
  main.apply({ tools, hooks: { register() {} }, self: { log: { info() {} } } })
  const generated = registered.get('my_text_stats')!
  expect(await generated.execute({ text: 'two words' }, {} as never)).toMatchObject({
    structured: { characters: 9, words: 2 },
  })
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
