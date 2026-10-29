import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_PLATFORM_IMPORTS } from '@agnes/protocol'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { assertClientExternals, clientImportMap } from '../../../tools/web-client-externals.mjs'
import { copyBundledExamples, copyBundledPlugins } from '../tools/build-local.js'
import { checkPackagedClientModules } from '../tools/client-module-check.js'

it.each(['@agnes/web-ui', '@agnes/web-client', 'react/jsx-runtime'])(
  'resolves emitted client imports through the served map: %s',
  async (specifier) => {
    const result = await build({
      stdin: { contents: `export * from '${specifier}'` },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      external: [specifier],
      metafile: true,
      write: false,
    })
    expect(() => assertClientExternals(result.metafile)).not.toThrow()
    const missingMapping = clientImportMap()
    delete missingMapping[specifier]
    expect(() => assertClientExternals(result.metafile, missingMapping)).toThrow(`external "${specifier}"`)
  },
)

it.each(['missing-module', '@agnes/web-ui/private', 'node:fs'])(
  'rejects an unresolvable emitted external: %s',
  async (specifier) => {
    const result = await build({
      stdin: { contents: `export const load = () => import('${specifier}')` },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      external: [specifier],
      metafile: true,
      write: false,
    })
    expect(() => assertClientExternals(result.metafile)).toThrow(`external "${specifier}"`)
  },
)

it('fails closed for a missing map or a mapped CommonJS require', () => {
  expect(() => clientImportMap('<html></html>')).toThrow('import map is missing')
  expect(() =>
    assertClientExternals({
      outputs: { 'client.js': { imports: [{ path: 'react', kind: 'require-call', external: true }] } },
    }),
  ).toThrow('require-call')
})

it('ships client packages whose external imports all resolve, and refuses a broken packaged entry', async () => {
  const output = await mkdtemp(join(tmpdir(), 'agh-client-imports-'))
  try {
    const imports = clientImportMap()
    for (const specifier of CLIENT_PLATFORM_IMPORTS) expect(imports[specifier]).toBeTruthy()
    await copyBundledPlugins(output)
    await copyBundledExamples(output)
    const payload = join(output, 'synthetic-client')
    await mkdir(join(payload, 'client/assets/textures'), { recursive: true })
    await writeFile(
      join(payload, 'package.json'),
      JSON.stringify({
        name: '@fixture/reports',
        version: '1.0.0',
        agnes: { clientDescriptors: [{ path: 'client/agnes.client.json' }] },
      }),
    )
    const descriptorPath = join(payload, 'client/agnes.client.json')
    await writeFile(
      descriptorPath,
      JSON.stringify({
        client: {
          entry: './index.js',
          styles: ['./style.css'],
          assets: ['./assets/explicit.bin'],
          streams: ['reports.events', 'reports.media'],
        },
      }),
    )
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
    expect(descriptor.client.streams).toEqual(['reports.events', 'reports.media'])
    const entry = join(payload, 'client/index.js')
    await writeFile(
      entry,
      "export * from '@agnes/web-client'; export const model = new URL('./assets/model.gltf', import.meta.url)",
    )
    await writeFile(
      join(payload, 'client/style.css'),
      "body { background: url('./assets/textures/background.png') }",
    )
    await writeFile(
      join(payload, 'client/assets/model.gltf'),
      JSON.stringify({
        buffers: [{ uri: 'model.bin' }],
        images: [{ uri: 'textures/surface.png' }],
      }),
    )
    for (const file of ['explicit.bin', 'model.bin', 'textures/surface.png', 'textures/background.png'])
      await writeFile(join(payload, 'client/assets', file), 'synthetic asset')
    await checkPackagedClientModules(payload)
    // These transitive resources are deliberately absent from client.assets.
    for (const file of ['model.bin', 'textures/surface.png', 'textures/background.png', 'explicit.bin']) {
      const asset = join(payload, 'client/assets', file)
      await rename(asset, `${asset}.missing`)
      await expect(checkPackagedClientModules(payload)).rejects.toThrow(
        `Missing client asset: client/assets/${file}`,
      )
      await rename(`${asset}.missing`, asset)
    }
    await checkPackagedClientModules(payload)
    await writeFile(entry, `export * from 'unmapped-package'`)
    await expect(checkPackagedClientModules(payload)).rejects.toThrow('external "unmapped-package"')
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 30_000)
