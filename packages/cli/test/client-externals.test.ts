import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    const mhs = join(output, 'bundled-plugins/mhs')
    const descriptor = JSON.parse(await readFile(join(mhs, 'agnes.client.json'), 'utf8'))
    const entry = join(mhs, descriptor.client.entry)
    await writeFile(entry, `export * from 'unmapped-package'`)
    await expect(checkPackagedClientModules(mhs)).rejects.toThrow('external "unmapped-package"')
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 30_000)
