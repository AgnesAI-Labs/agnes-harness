import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ENABLED_BUNDLED_PACKAGES, OPTIONAL_BUNDLED_PACKAGES } from '@agnes/package-manager'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
import { prepareBrowserRuntime } from '../tools/browser-runtime.js'
import { copyBundledExamples, copyBundledPlugins } from '../tools/build-local.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it.each([
  { name: 'skill-helper', exportName: 'skillHelper', tools: 4 },
  { name: 'mcp-helper', exportName: 'mcpHelper', tools: 1 },
  { name: 'plugin-helper', exportName: 'pluginHelper', tools: 3 },
  { name: 'document-reader', exportName: 'documentReader', tools: 1 },
])('ships and relocates $name outside source workspace', async (helper) => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-helper-delivery-'))
  roots.push(root)
  const output = join(root, 'runtime')
  await copyBundledPlugins(output)
  expect(OPTIONAL_BUNDLED_PACKAGES.map((pkg) => pkg.id)).toEqual(['@agnes/browser-ui'])
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
  if (helper.name === 'skill-helper') {
    const browser = join(relocated, 'bundled-plugins/browser-runtime')
    const provenance = JSON.parse(await readFile(join(browser, 'dist/provenance.json'), 'utf8'))
    expect(provenance.version).toBe('0.39.1')
    expect(await readFile(join(browser, 'dist/agent-browser-LICENSE'), 'utf8')).toContain('Apache License')
    // Exercise the relocated native payload, without launching Chrome or requiring a browser download.
    const arch = process.platform === 'win32' && process.arch === 'arm64' ? 'x64' : process.arch
    const binary = `agent-browser-${process.platform}-${arch}${process.platform === 'win32' ? '.exe' : ''}`
    expect(await readdir(join(browser, 'dist/bin'))).toEqual([binary])
    expect(provenance.binaries).toEqual([binary])
    expect(
      execFileSync(join(browser, 'dist/bin', binary), ['--version'], { windowsHide: true, encoding: 'utf8' }),
    ).toContain('0.39.1')
    expect(await readFile(join(relocated, 'bundled-plugins/browser-ui/src/browser.css'), 'utf8')).toContain(
      '@layer app',
    )
  }
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

it.each([
  ['win32', 'x64', 'agent-browser-win32-x64.exe'],
  ['win32', 'arm64', 'agent-browser-win32-x64.exe'],
  ['darwin', 'arm64', 'agent-browser-darwin-arm64'],
  ['darwin', 'x64', 'agent-browser-darwin-x64'],
  ['linux', 'x64', 'agent-browser-linux-x64'],
  ['linux', 'arm64', 'agent-browser-linux-arm64'],
] as const)('ships only the %s/%s browser payload, including on rebuild', async (platform, arch, binary) => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-browser-delivery-'))
  roots.push(root)
  const bin = join(root, 'dist/bin')
  await mkdir(bin, { recursive: true })
  // Simulate an older build that bundled every platform; preserve unrelated files.
  for (const name of ['agent-browser-win32-x64.exe', 'agent-browser-darwin-arm64', 'NOTICE'])
    await writeFile(join(bin, name), 'old build')
  await prepareBrowserRuntime(root, { platform, arch })
  expect((await readdir(bin)).sort()).toEqual([binary, 'NOTICE'].sort())
  const { binaries } = JSON.parse(await readFile(join(root, 'dist/provenance.json'), 'utf8'))
  expect(binaries).toEqual([binary])
  expect((await readFile(join(bin, binary))).byteLength).toBeGreaterThan(1_000_000)
  await expect(prepareBrowserRuntime(root, { platform, arch: 'ia32' })).rejects.toThrow('Unsupported')
  expect((await readdir(bin)).sort()).toEqual([binary, 'NOTICE'].sort())
})

it('ships all official example payloads with runnable community entries and no checkout-only files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-example-delivery-'))
  roots.push(root)
  await copyBundledExamples(root)
  const families = await readdir(join(root, 'bundled-examples'))
  expect(families.sort()).toEqual(['community', 'fde', 'loops'])
  expect(await readdir(join(root, 'bundled-examples/fde'))).toHaveLength(12)
  expect(await readdir(join(root, 'bundled-examples/loops'))).toHaveLength(2)
  for (const name of ['tool-panel', 'mcp-skills', 'dag-loop-adapter']) {
    const payload = join(root, 'bundled-examples/community', name)
    expect(await readFile(join(payload, 'dist/index.js'), 'utf8')).toContain('export')
    expect(await readdir(payload)).not.toEqual(expect.arrayContaining(['test', 'node_modules', 'src']))
    expect(await readFile(join(payload, 'LICENSE'), 'utf8')).toContain('Apache')
  }
})
