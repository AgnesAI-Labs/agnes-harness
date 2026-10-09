import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readWebStyleSource } from '../web-style-source.mjs'

// Explicit offline renderer acceptance fixture; invoked only by the Web spec.
const require = createRequire(resolve('packages/web/package.json'))
const { build } = require('esbuild')
const directory = await mkdtemp(join(tmpdir(), 'agh-intelligent-ui-fixture-'))
await build({
  entryPoints: [process.argv[2] ?? 'tools/e2e-web/fixtures/intelligent-ui.tsx'],
  outfile: join(directory, 'fixture.js'),
  bundle: true,
  format: 'esm',
  target: 'es2023',
  platform: 'browser',
  jsx: 'automatic',
  nodePaths: [resolve('packages/web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
})
const style =
  readWebStyleSource(resolve('packages/web/public/style.css')) +
  (await readFile('packages/web-ui/src/intelligent-ui/styles.css', 'utf8'))
const assets = new Map([
  ['/fixture.js', [join(directory, 'fixture.js'), 'text/javascript']],
  ['/tokens.css', [resolve('packages/web-ui/src/tokens.css'), 'text/css']],
  ['/antd.css', [require.resolve('antd/dist/antd.css', { paths: [resolve('packages/web-ui')] }), 'text/css']],
])
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (path === '/') {
    response
      .writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      .end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/antd.css"></head><body><div id="fixture-root"></div><script type="module" src="/fixture.js"></script></body></html>',
      )
    return
  }
  if (path === '/style.css') {
    response.writeHead(200, { 'Content-Type': 'text/css' }).end(style)
    return
  }
  const asset = assets.get(path)
  if (!asset) {
    response.writeHead(404).end()
    return
  }
  try {
    response
      .writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' })
      .end(await readFile(asset[0]))
  } catch {
    response.writeHead(500).end('Fixture asset unavailable')
  }
})
server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`))
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => void rm(directory, { recursive: true, force: true }).then(() => process.exit(0))),
  )
