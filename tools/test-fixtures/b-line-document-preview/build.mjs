import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const fixture = import.meta.dirname
const repository = resolve(fixture, '../../..')
const require = createRequire(resolve(repository, 'packages/web/package.json'))
const { build } = require('esbuild')
const assets = resolve(repository, 'packages/cli/dist/local/web')
const out = '/private/tmp/agh-w6b2-browser'
await mkdir(out, { recursive: true })
await cp(assets, out, { recursive: true })
await build({
  entryPoints: [resolve(fixture, 'probe.jsx')],
  outfile: resolve(out, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  target: ['es2023'],
  legalComments: 'eof',
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@agnes/cordis',
    '@agnes/web-client',
    '@agnes/web-ui/assistant-ui',
    'antd',
  ],
})
const html = await readFile(resolve(assets, 'index.html'), 'utf8')
await writeFile(resolve(out, 'index.html'), html)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const files = [
  'style.css',
  'tokens.css',
  'antd.css',
  'vendor/react.js',
  'vendor/react-dom.js',
  'vendor/antd.js',
  'vendor/web-client.js',
  'vendor/assistant-ui.js',
  'THIRD-PARTY-NOTICES/x-markdown.txt',
]
const sharedAssets = []
for (const file of files) {
  const source = await readFile(resolve(assets, file))
  const running = await readFile(resolve(out, file))
  if (digest(source) !== digest(running)) throw new Error(`Runtime asset differs: ${file}`)
  sharedAssets.push({ file, sha256: digest(source) })
}
const sources = [
  'packages/web/src/region-slots.ts',
  'packages/web/src/client-modules/boot.ts',
  'packages/web-client/src/services.ts',
  'packages/web-client/src/outlet.tsx',
  'packages/web-ui/src/conversation/document-preview.tsx',
  'packages/web-ui/src/conversation/document-preview-policy.ts',
  'packages/web/public/style.css',
  'packages/web/src/serve-entry.ts',
  'packages/web/src/serve.ts',
  'packages/web-server/src/server.ts',
  'tools/test-fixtures/b-line-document-preview/probe.jsx',
]
const sourceHashes = []
for (const file of sources)
  sourceHashes.push({ file, sha256: digest(await readFile(resolve(repository, file))) })
await writeFile(
  '/private/tmp/agh-w6b2-runtime-manifest.json',
  `${JSON.stringify(
    {
      node: process.version,
      out,
      backend:
        'synthetic authorized artifact.read RPC; actual client resource adapter and rightbar; no daemon/SDK transport',
      sources: sourceHashes,
      sharedAssets,
      probeSha256: digest(await readFile(resolve(out, 'app.js'))),
      packagedAppSha256: digest(await readFile(resolve(assets, 'app.js'))),
    },
    null,
    2,
  )}\n`,
)
console.log(out)
