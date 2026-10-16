import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTemplate } from '@agnes/host'
import { loadRuntimePackage, preflightRuntimePackage } from '@agnes/host-extensions/assemble/packages'
import { createLoader } from '@agnes/host-extensions/ext-host/loader'
import { emptyLock, runtimePluginSnapshotsFromInventory, writeLock } from '@agnes/package-manager'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
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

it('ships all official example payloads with runnable community entries and no checkout-only files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-example-delivery-'))
  roots.push(root)
  await copyBundledExamples(root)
  const families = await readdir(join(root, 'bundled-examples'))
  expect(families.sort()).toEqual(['community', 'fde', 'loops', 'mhs'])
  expect(await readdir(join(root, 'bundled-examples/fde'))).toHaveLength(12)
  expect(await readdir(join(root, 'bundled-examples/loops'))).toHaveLength(2)
  expect(await readdir(join(root, 'bundled-examples/mhs'))).toEqual(['mars-rescue'])
  const mars = join(root, 'bundled-examples/mhs/mars-rescue')
  const manifest = JSON.parse(await readFile(join(mars, 'package.json'), 'utf8'))
  expect(manifest.name).toBe('@agnes-example/mars-rescue')
  for (const entry of Object.values(manifest.exports) as string[])
    expect((await readFile(join(mars, entry))).length).toBeGreaterThan(0)
  const files = await readdir(mars)
  for (const excluded of ['test', 'node_modules', 'tsconfig.json']) expect(files).not.toContain(excluded)
  expect(await readFile(join(mars, 'LICENSE'), 'utf8')).toContain('Apache')
  expect(await readFile(join(mars, 'NOTICE'), 'utf8')).toContain('Mars')
  const resources = JSON.parse(await readFile(join(mars, 'assets/manifest.json'), 'utf8'))
  for (const resource of resources.resources) {
    const bytes = await readFile(join(mars, resource.path))
    expect(bytes.length).toBe(resource.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(resource.sha256)
  }
  for (const name of ['tool-panel', 'mcp-skills', 'dag-loop-adapter']) {
    const payload = join(root, 'bundled-examples/community', name)
    expect(await readFile(join(payload, 'dist/index.js'), 'utf8')).toContain('export')
    expect(await readdir(payload)).not.toEqual(expect.arrayContaining(['test', 'node_modules', 'src']))
    expect(await readFile(join(payload, 'LICENSE'), 'utf8')).toContain('Apache')
  }
})

it('ships an installable MHS backend, Hub and profile client outside the checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-mhs-delivery-'))
  roots.push(root)
  await copyBundledPlugins(root)
  const payload = join(root, 'bundled-plugins/mhs')
  const manifest = JSON.parse(await readFile(join(payload, 'package.json'), 'utf8'))
  expect(manifest.name).toBe('@agnes/mhs')
  expect(await readdir(payload)).not.toEqual(expect.arrayContaining(['src', 'test', 'node_modules']))
  expect(await readFile(join(payload, 'LICENSE'), 'utf8')).toContain('Apache')
  expect(await readdir(join(payload, 'THIRD-PARTY-NOTICES'))).toEqual(
    expect.arrayContaining(['ws.txt', 'sinclair-typebox.txt']),
  )
  const descriptor = JSON.parse(await readFile(join(payload, 'agnes.client.json'), 'utf8'))
  expect(descriptor.client).toMatchObject({
    lifetime: 'profile',
    homeEntries: [{ id: 'mhs', placement: 'primary' }],
  })
  for (const path of [manifest.exports['.'], descriptor.client.entry, ...descriptor.client.styles])
    expect((await readFile(join(payload, path))).length).toBeGreaterThan(0)
  // Bundle the actual first-start path beside the relocated payload, just as local/SEA delivery does.
  const bootstrap = join(root, 'bootstrap.mjs')
  const initializer = fileURLToPath(
    new URL('../../daemon-admin/src/packages/default-helpers.ts', import.meta.url),
  )
  const managerModule = fileURLToPath(new URL('../../package-manager/src/index.ts', import.meta.url))
  await build({
    stdin: {
      contents: `export { initializeDefaultHelpers } from ${JSON.stringify(initializer)}; export { createPackageManager } from ${JSON.stringify(managerModule)}`,
      resolveDir: root,
    },
    outfile: bootstrap,
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: { AGNES_PACKAGED_BUILTINS: 'true' },
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  })
  const boot = await import(bootstrap)
  const profile = join(root, 'profiles/local-dev')
  const manager = boot.createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.0.0',
    references: async () => [],
  })
  await boot.initializeDefaultHelpers({
    profileDir: profile,
    manager,
    initializePolicy: async () =>
      writeLock(profile, {
        ...emptyLock('local-dev', '0.0.0'),
        policySnapshot: {
          capabilityCeiling: loadTemplate('local-dev').policy?.capabilityCeiling ?? [],
          workspacePackages: 'require-project-trust',
        },
        resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
        seams: Object.fromEntries(
          ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map(
            (name) => [name, { provider: 'local' }],
          ),
        ),
      }),
  })
  expect(
    (await manager.inventory(profile)).packages.find((pkg: { id: string }) => pkg.id === manifest.name),
  ).toMatchObject({ enabled: true, trusted: true })
  const installed = runtimePluginSnapshotsFromInventory(await manager.inventory(profile)).find(
    (item) => item.snapshot.packageId === manifest.name,
  )
  if (!installed) throw new Error('MHS was not installed')
  preflightRuntimePackage(installed)
  const loaded = await loadRuntimePackage(
    installed,
    createLoader({
      cacheDir: join(root, 'cache'),
      hostRoot: fileURLToPath(new URL('../../host-extensions/', import.meta.url)),
      agnesVersion: '0.0.0',
    }),
  )
  expect(loaded?.module.plugins?.map((plugin) => plugin.declaration.id)).toContain('ext:agnes.mhs')
})
