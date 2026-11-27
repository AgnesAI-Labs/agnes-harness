import { copyFile, readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { build } = createRequire(new URL('../packages/web-ui/package.json', import.meta.url))('esbuild')

/** PDF.js and its font/CMap data stay in one lazy, offline viewer bundle. */
export async function buildPdfPreview(webOutput) {
  const require = createRequire(new URL('../packages/web-ui/package.json', import.meta.url))
  const resources = {}
  for (const [kind, folder] of [
    ['cMapUrl', 'cmaps'],
    ['standardFontDataUrl', 'standard_fonts'],
  ]) {
    const root = join(dirname(require.resolve('pdfjs-dist/package.json')), folder)
    for (const file of await readdir(root))
      if (/\.(bcmap|pfb|ttf)$/.test(file))
        resources[`${kind}/${file}`] = (await readFile(join(root, file))).toString('base64')
  }
  return build({
    absWorkingDir: fileURLToPath(new URL('../packages/web/', import.meta.url)),
    entryPoints: [fileURLToPath(new URL('../packages/web/tools/pdf-preview-entry.js', import.meta.url))],
    outfile: join(webOutput, 'vendor', 'pdf-preview.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2023'],
    minify: true,
    metafile: true,
    alias: {
      'pdfjs-dist/build/pdf.mjs': require.resolve('pdfjs-dist/build/pdf.mjs'),
      'pdfjs-dist/build/pdf.worker.mjs': require.resolve('pdfjs-dist/build/pdf.worker.mjs'),
    },
    define: {
      __AGNES_PDF_RESOURCES__: JSON.stringify(resources),
      'import.meta.url': 'location.href',
    },
  })
}

export async function copyPdfPreviewNotice(webOutput) {
  const require = createRequire(new URL('../packages/web-ui/package.json', import.meta.url))
  const root = join(require.resolve('pdfjs-dist/package.json'), '..')
  for (const [folder, file] of [
    ['cmaps', 'LICENSE'],
    ['standard_fonts', 'LICENSE_FOXIT'],
    ['standard_fonts', 'LICENSE_LIBERATION'],
  ])
    await copyFile(
      join(root, folder, file),
      join(webOutput, 'THIRD-PARTY-NOTICES', `pdfjs-${folder}-${file}.txt`),
    )
}
