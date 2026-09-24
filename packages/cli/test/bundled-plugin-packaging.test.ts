import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
import { copyBundledPlugins } from '../tools/build-local.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it.each([
  { name: 'skill-helper', exportName: 'skillHelper', tools: 4 },
  { name: 'mcp-helper', exportName: 'mcpHelper', tools: 1 },
  { name: 'plugin-helper', exportName: 'pluginHelper', tools: 3 },
])('ships and relocates $name outside source workspace', async (helper) => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-helper-delivery-'))
  roots.push(root)
  const output = join(root, 'runtime')
  await copyBundledPlugins(output)
  expect((await readdir(join(output, 'bundled-plugins', helper.name))).sort()).toEqual(
    ['LICENSE', 'README.md', 'index.mjs', 'package.json', 'src'].sort(),
  )
  const resolver = fileURLToPath(
    new URL('../../package-manager/src/bundled-plugin-source.ts', import.meta.url),
  )
  await build({
    stdin: {
      contents: `import { bundledPluginSourceRoot, BUNDLED_HELPERS } from ${JSON.stringify(resolver)}; import { readFileSync } from 'node:fs'; import { join } from 'node:path'; import { pathToFileURL } from 'node:url'; const tools = []; (await import(pathToFileURL(join(bundledPluginSourceRoot(BUNDLED_HELPERS.find(h=>h.name===${JSON.stringify(helper.name)}).ref), 'bundled-plugins/'+${JSON.stringify(helper.name)}+'/index.mjs')).href))[${JSON.stringify(helper.exportName)}].apply({extension:()=>({registerTool: tool => tools.push(tool.name)})}); if (tools.length !== ${helper.tools}) throw new Error('Missing tools'); console.log(JSON.parse(readFileSync(join(bundledPluginSourceRoot(BUNDLED_HELPERS.find(h=>h.name===${JSON.stringify(helper.name)}).ref), 'bundled-plugins/'+${JSON.stringify(helper.name)}+'/package.json'), 'utf8')).name)`,
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
