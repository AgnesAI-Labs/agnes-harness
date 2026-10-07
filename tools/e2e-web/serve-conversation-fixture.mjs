import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Explicit browser-only acceptance fixture. Dependencies and styles come from the current Web package.
const require = createRequire(resolve('packages/web/package.json'))
const { build } = require('esbuild')
const directory = await mkdtemp(join(tmpdir(), 'agh-conversation-fixture-'))
await build({
  entryPoints: ['tools/e2e-web/fixtures/conversation.tsx'],
  outfile: join(directory, 'fixture.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  nodePaths: [resolve('packages/web/node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
})
const assets = new Map([
  ['/fixture.js', [join(directory, 'fixture.js'), 'text/javascript']],
  ['/style.css', [resolve('packages/web/dist/web/style.css'), 'text/css']],
  ['/tokens.css', [resolve('packages/web-ui/src/tokens.css'), 'text/css']],
  ['/antd.css', [resolve('packages/web/dist/web/antd.css'), 'text/css']],
])
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (path === '/') {
    response
      .writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      .end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/antd.css"><style>.conversation-fixture { height:100dvh; overflow:auto; padding:1rem; max-width:58rem; margin:auto; } .conversation-fixture #approval { max-width:100%; } body { overflow:hidden; }</style></head><body><div id="fixture-root"></div><script type="module" src="/fixture.js"></script></body></html>',
      )
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
    response.writeHead(500).end('Build the web assets before starting the fixture.')
  }
})
server.listen(Number(process.env.AGH_CONVERSATION_FIXTURE_PORT ?? 0), '127.0.0.1', () =>
  console.log(`http://127.0.0.1:${server.address().port}`),
)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => void rm(directory, { recursive: true, force: true }).then(() => process.exit(0))),
  )
