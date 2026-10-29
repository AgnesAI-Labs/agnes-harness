import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  BUNDLED_EXAMPLES,
  BUNDLED_PLUGIN_DIGESTS,
  bundledPluginDigest,
  DEFAULT_ENABLED_BUNDLED_PACKAGES,
  hashDirectory,
  OPTIONAL_BUNDLED_PACKAGES,
} from '@agnes/package-manager'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
import { copyBundledExamples, copyBundledPlugins } from '../tools/build-local.js'
import { copyExamplePayload } from '../tools/example-payload.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it.each([
  { name: 'skill-helper', exportName: 'skillHelper', tools: 4 },
  { name: 'mcp-helper', exportName: 'mcpHelper', tools: 1 },
  { name: 'plugin-helper', exportName: 'pluginHelper', tools: 4 },
  { name: 'document-reader', exportName: 'documentReader', tools: 1 },
])('ships and relocates $name outside source workspace', async (helper) => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-helper-delivery-'))
  roots.push(root)
  const output = join(root, 'runtime')
  await copyBundledPlugins(output)
  expect(OPTIONAL_BUNDLED_PACKAGES.map((pkg) => pkg.name)).toEqual(['jev-loop'])
  // The release digest is the same formula boot would otherwise compute over the final payload.
  const payload = { root: output, path: `bundled-plugins/${helper.name}` }
  expect(bundledPluginDigest(payload)).toBe(hashDirectory(join(output, payload.path)))
  expect(Object.keys(JSON.parse(await readFile(join(output, BUNDLED_PLUGIN_DIGESTS), 'utf8')))).toHaveLength(
    DEFAULT_ENABLED_BUNDLED_PACKAGES.length + OPTIONAL_BUNDLED_PACKAGES.length,
  )
  expect((await readdir(join(output, 'bundled-plugins'))).sort()).toEqual(
    [...DEFAULT_ENABLED_BUNDLED_PACKAGES, ...OPTIONAL_BUNDLED_PACKAGES].map((pkg) => pkg.name).sort(),
  )
  expect((await readdir(join(output, 'bundled-plugins', helper.name))).sort()).toEqual(
    [
      'LICENSE',
      'README.md',
      ...(helper.name === 'document-reader' ? ['dist'] : []),
      'index.mjs',
      'package.json',
      'src',
    ].sort(),
  )
  if (helper.name === 'document-reader') {
    const notices = await readdir(
      join(output, 'bundled-plugins', helper.name, 'dist/runtime/THIRD-PARTY-NOTICES'),
    )
    expect(notices).toEqual(
      expect.arrayContaining([
        'saxes.txt',
        'pdfium-third-party.txt',
        'tesseract.txt',
        'leptonica.txt',
        'tessdata-Apache-2.0.txt',
      ]),
    )
  }
  const resolver = fileURLToPath(
    new URL('../../package-manager/src/bundled-plugin-source.ts', import.meta.url),
  )
  await build({
    stdin: {
      contents: `import { bundledPluginSourceRoot, BUNDLED_HELPERS } from ${JSON.stringify(resolver)}; import { readFileSync } from 'node:fs'; import { join } from 'node:path'; import { pathToFileURL } from 'node:url'; const tools = []; (await import(pathToFileURL(join(bundledPluginSourceRoot(BUNDLED_HELPERS.find(h=>h.name===${JSON.stringify(helper.name)}).ref), 'bundled-plugins/'+${JSON.stringify(helper.name)}+'/index.mjs')).href))[${JSON.stringify(helper.exportName)}].apply({effect: factory => factory(), tools:{register: tool => tools.push(tool.name)}}); if (tools.length !== ${helper.tools}) throw new Error('Missing tools'); console.log(JSON.parse(readFileSync(join(bundledPluginSourceRoot(BUNDLED_HELPERS.find(h=>h.name===${JSON.stringify(helper.name)}).ref), 'bundled-plugins/'+${JSON.stringify(helper.name)}+'/package.json'), 'utf8')).name)`,
      resolveDir: root,
    },
    outfile: join(output, 'probe.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: { AGNES_PACKAGED_BUILTINS: 'true' },
  })
  const relocated = join(root, 'relocated-runtime')
  await rename(output, relocated)
  expect(
    execFileSync(process.execPath, [join(relocated, 'probe.mjs')], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
  ).toBe(`@agnes/${helper.name}`)
  // A missing sidecar must not fall back to a same-named folder in the user's cwd.
  const impostor = join(root, 'bundled-plugins', helper.name)
  await mkdir(impostor, { recursive: true })
  await writeFile(join(impostor, 'package.json'), JSON.stringify({ name: 'impostor' }))
  await rename(join(relocated, 'bundled-plugins'), join(relocated, 'payload-backup'))
  expect(() =>
    execFileSync(process.execPath, [join(relocated, 'probe.mjs')], {
      cwd: root,
      windowsHide: true,
      stdio: 'pipe',
    }),
  ).toThrow()
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  expect(pkg.files).toEqual(
    expect.arrayContaining(['dist/local/bundled-plugins', 'dist/sea/bundled-plugins']),
  )
  expect(await readFile(new URL('../sea/build.mjs', import.meta.url), 'utf8')).toContain("'bundled-plugins'")
})

it('ships the optional Jev loop payload with a bundle generated from loop-jev', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-jev-delivery-'))
  roots.push(root)
  await copyBundledPlugins(root)
  const payload = join(root, 'bundled-plugins', 'jev-loop')
  expect((await readdir(payload)).sort()).toEqual([
    'LICENSE',
    'NOTICE',
    'README.md',
    'index.mjs',
    'package.json',
  ])
  // @agnes/extension-api is host-provided, so the bundle cannot load here; check its text instead.
  const bundle = await readFile(join(payload, 'index.mjs'), 'utf8')
  expect(bundle).toMatch(/^export \{[^}]*\bjevLoopPlugin\b[^}]*\}/m)
  expect(bundle).toContain('from "@agnes/extension-api"')
})

it('ships all official example payloads with runnable community entries and no checkout-only files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-example-delivery-'))
  roots.push(root)
  await copyBundledExamples(root)
  const families = await readdir(join(root, 'bundled-examples'))
  // The catalog is the single source of truth for which example families and payloads ship.
  expect(families.sort()).toEqual([...new Set(BUNDLED_EXAMPLES.map((example) => example.family))].sort())
  expect((await readdir(join(root, 'bundled-examples/fde'))).sort()).toEqual(
    BUNDLED_EXAMPLES.filter((example) => example.family === 'fde')
      .map((example) => example.name)
      .sort(),
  )
  expect(await readdir(join(root, 'bundled-examples/loops'))).toHaveLength(2)
  for (const name of ['tool-panel', 'mcp-skills', 'dag-loop-adapter']) {
    const payload = join(root, 'bundled-examples/community', name)
    expect(await readFile(join(payload, 'dist/index.js'), 'utf8')).toContain('export')
    expect(await readdir(payload)).not.toEqual(expect.arrayContaining(['test', 'node_modules', 'src']))
    expect(await readFile(join(payload, 'LICENSE'), 'utf8')).toContain('Apache')
  }
})

it('packages a declared TypeScript entry and public Markdown without a family privilege or prebuilt dist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-example-source-'))
  roots.push(root)
  const source = join(root, 'source'),
    output = join(root, 'payload')
  await mkdir(join(source, 'src'), { recursive: true })
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name: '@fictional/quality',
      version: '1.0.0',
      type: 'module',
      exports: './dist/index.js',
      files: ['dist', 'DEMO.md', 'DOMAIN-NOTES.md'],
    }),
  )
  await writeFile(
    join(source, 'src/index.ts'),
    'const value: string = "fictional"; export const main = { apply() {} }; export { value };',
  )
  for (const name of ['DEMO.md', 'DOMAIN-NOTES.md', 'unpublished.md'])
    await writeFile(join(source, name), name)
  await copyExamplePayload(source, output)
  const loaded = await import(pathToFileURL(join(output, 'dist/index.js')).href)
  expect(loaded.value).toBe('fictional')
  expect(typeof loaded.main.apply).toBe('function')
  expect(await readFile(join(output, 'DEMO.md'), 'utf8')).toBe('DEMO.md')
  expect(await readFile(join(output, 'DOMAIN-NOTES.md'), 'utf8')).toBe('DOMAIN-NOTES.md')
  expect(await readdir(output)).not.toEqual(expect.arrayContaining(['src', 'unpublished.md']))
})
