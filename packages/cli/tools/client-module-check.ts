import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'
import { assertClientExternals } from '../../../tools/web-client-externals.mjs'

/** Validate every declared client entry, including prebuilt payloads copied without bundling. */
export async function checkPackagedClientModules(root: string): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  for (const descriptor of manifest.agnes?.clientDescriptors ?? []) {
    const path = resolve(root, descriptor.path)
    const { client } = JSON.parse(await readFile(path, 'utf8'))
    if (!client?.entry) continue
    const result = await build({
      entryPoints: [resolve(dirname(path), client.entry)],
      bundle: true,
      packages: 'external',
      platform: 'browser',
      format: 'esm',
      metafile: true,
      write: false,
      logLevel: 'silent',
    })
    assertClientExternals(result.metafile)
  }
}
