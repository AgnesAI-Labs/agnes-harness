import { readFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'
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
      absWorkingDir: root,
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
    // Descriptor resources are not ESM imports: esbuild cannot discover them. Check the
    // shipped tree, including relative URLs in JS/CSS and glTF buffer/image dependencies.
    const base = dirname(path)
    const checked = new Set<string>()
    const queue = [client.entry, ...(client.styles ?? []), ...(client.assets ?? [])].map((asset) =>
      resolve(base, asset),
    )
    queue.push(...Object.keys(result.metafile.inputs).map((file) => resolve(root, file)))
    while (queue.length) {
      const asset = queue.shift()
      if (!asset || checked.has(asset)) continue
      const rel = relative(root, asset)
      // Report the payload path as the manifest spells it, '/'-separated on every platform.
      const shown = rel.split(sep).join('/')
      if (rel.startsWith('..') || resolve(root, rel) !== asset)
        throw new Error(`Client asset escapes payload: ${shown}`)
      checked.add(asset)
      const bytes = await readFile(asset).catch(() => {
        throw new Error(`Missing client asset: ${shown}`)
      })
      const references: string[] = []
      const text = /\.(?:m?js|css|gltf)$/.test(asset) ? bytes.toString('utf8') : ''
      if (/\.(?:m?js)$/.test(asset)) {
        for (const match of text.matchAll(/new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g))
          if (match[1]) references.push(match[1])
        // Interpolated URLs cannot be enumerated statically: their concrete files must be
        // declared in client.assets and are checked above (for example a fixed runtime-selected model set).
      } else if (extname(asset) === '.css') {
        for (const match of text
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .matchAll(/(?:url\(\s*['"]?([^'"\s)]+)|@import\s+['"]([^'"]+))/g)) {
          const reference = match[1] ?? match[2]
          if (reference) references.push(reference)
        }
      } else if (extname(asset) === '.gltf') {
        const model = JSON.parse(text)
        for (const resource of [...(model.buffers ?? []), ...(model.images ?? [])])
          if (typeof resource.uri === 'string') references.push(resource.uri)
      }
      for (const reference of references) {
        if (/^(?:[a-z]+:|\/|#)/i.test(reference)) continue
        const path = reference.split(/[?#]/)[0]
        if (path) queue.push(resolve(dirname(asset), decodeURIComponent(path)))
      }
    }
  }
}
