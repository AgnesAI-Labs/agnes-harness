import { copyFile, cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { collectThirdPartyNotices } from '../../../tools/third-party-notices.mjs'

export const documentReaderSource = fileURLToPath(
  new URL('../../package-manager/bundled-plugins/document-reader/', import.meta.url),
)

/** Assemble this ordinary plugin's pinned JS/WASM payload; no Office executable or native addon. */
export async function prepareDocumentReader(destination = documentReaderSource): Promise<void> {
  const runtime = join(destination, 'src', 'runtime')
  const assets = join(runtime, 'assets')
  const require = createRequire(join(documentReaderSource, 'package.json'))
  await mkdir(assets, { recursive: true })
  const bundled = await build({
    absWorkingDir: documentReaderSource,
    entryPoints: [join(documentReaderSource, 'src', 'engine.mjs')],
    outfile: join(runtime, 'engine.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node24'],
    legalComments: 'eof',
    metafile: true,
    logLevel: 'warning',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  })
  await copyFile(require.resolve('@hyzyla/pdfium/pdfium.wasm'), join(assets, 'pdfium.wasm'))
  const ocrRoot = dirname(require.resolve('tesseract-wasm'))
  for (const name of ['tesseract-core.wasm', 'tesseract-core-fallback.wasm'])
    await copyFile(join(ocrRoot, name), join(assets, name))
  for (const language of ['chi_sim', 'eng']) {
    const root = dirname(require.resolve(`@tesseract.js-data/${language}`))
    const compressed = await readFile(join(root, '4.0.0_best_int', `${language}.traineddata.gz`))
    await writeFile(
      join(assets, `${language}.traineddata`),
      gunzipSync(compressed, { maxOutputLength: 32 * 1024 * 1024 }),
    )
    // These npm model packages declare MIT but ship no LICENSE file. Preserve their metadata/readme
    // and the upstream Apache license for the traineddata, alongside the compiled engine notices.
    await cp(join(root, 'README.md'), join(assets, `${language}-README.md`))
  }
  await collectThirdPartyNotices(documentReaderSource, runtime, [bundled], {
    saxes: join(documentReaderSource, 'src', 'notices', 'saxes.txt'),
  })
  const notices = join(runtime, 'THIRD-PARTY-NOTICES')
  await cp(join(documentReaderSource, 'src', 'notices'), notices, { recursive: true })
  // Both WASM wrappers ship LICENSE.md; they may not occur in a JS metafile after tree-shaking.
  for (const [name, root] of [
    ['pdfium', dirname(dirname(require.resolve('@hyzyla/pdfium')))],
    ['tesseract-wasm', dirname(ocrRoot)],
  ] as const)
    await copyFile(join(root, 'LICENSE.md'), join(notices, `${name}.txt`))
  await copyFile(join(documentReaderSource, 'LICENSE'), join(notices, 'tessdata-Apache-2.0.txt'))
  const files = await readdir(assets)
  if (
    ![
      'pdfium.wasm',
      'tesseract-core.wasm',
      'tesseract-core-fallback.wasm',
      'chi_sim.traineddata',
      'eng.traineddata',
    ].every((name) => files.includes(name))
  )
    throw new Error('Document reader runtime payload is incomplete')
}
