import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, request as requestHttp } from 'node:http'
import https from 'node:https'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { uiComponentFrame } from '../../packages/web-server/src/ui-component-frame.ts'
import { inCssLayer, readWebStyleSource, readWebUiStyleSource } from '../web-style-source.mjs'

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
  if (path === '/plugins/generations/11111111-1111-1111-1111-111111111111/finance/reviewed/diff.mjs') {
    const frame = uiComponentFrame(`export const renderers = {
      'finance/reconcile/diff@1'(mount, props, api) {
        if (props.fail) throw new Error('synthetic renderer failure');
        const probe = new Image();
        probe.src = 'https://csp-blocked.invalid/exfil.png';
        mount.append(probe);
        try {
          const nested = document.createElement('iframe');
          mount.append(nested);
          nested.contentWindow?.fetch('https://csp-blocked.invalid/subframe').catch(() => {});
        } catch {}
        const summary = document.createElement('p');
        summary.textContent = 'Delta cents: ' + props.amount;
        const button = document.createElement('button');
        button.textContent = 'Review adjustments';
        button.onclick = () => api.emitAction('confirm');
        mount.append(summary, button);
      }
    };`)
    response
      .writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': frame.csp,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      })
      .end(frame.body)
    return
  }
  if (path === '/') {
    const reqUrl = new URL(request.url ?? '/', webOrigin)
    if (reqUrl.searchParams.get('host') === 'cloud') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(
        `<!doctype html><html><body style="margin:0"><script>
            addEventListener('message', (event) => {
              const frame = document.getElementById('cloud');
              if (
                event.source === frame?.contentWindow &&
                event.data?.type === 'agh.backend.frame/v1' &&
                event.data.kind === 'authorization-request'
              ) {
                frame.contentWindow.postMessage({
                  type: 'agh.backend.frame/v1',
                  kind: 'authorization',
                  requestId: event.data.requestId,
                  remote: 'https://8443-fixture.ap-shanghai.tencentags.com',
                  path: ${JSON.stringify(cloudSessionPath)},
                  proxied: true,
                }, ${JSON.stringify(cloudOrigin)});
              }
            });
          </script><iframe id="cloud" data-testid="cloud-stage" style="border:0;width:100vw;height:100vh" sandbox="allow-scripts allow-same-origin allow-forms" src="${cloudOrigin}/?custom=cloud-ready&locale=${reqUrl.searchParams.get('locale') ?? 'en'}"></iframe></body></html>`,
      )
      return
    }
    response
      .writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      .end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/antd.css"><style>body { display:block; } #fixture-root { height:100dvh; min-width:0; }</style></head><body><div id="fixture-root"></div><script type="module" src="/fixture.js"></script></body></html>',
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
      .end(
        path === '/tokens.css'
          ? readWebUiStyleSource(asset[0])
          : path === '/antd.css'
            ? inCssLayer(await readFile(asset[0], 'utf8'), 'vendor')
            : await readFile(asset[0]),
      )
  } catch {
    response.writeHead(500).end('Fixture asset unavailable')
  }
})
let cloudOrigin = ''
let cloudSessionPath = ''
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const webOrigin = `http://127.0.0.1:${server.address().port}`
const cloudKey = 'fixture-intelligent-ui-cloud-key'
let publicationOrigin = webOrigin
https.request = (url, options, callback) =>
  requestHttp(new URL(url.pathname + url.search, publicationOrigin), options, callback)
syncBuiltinESMExports()
const bridgeOut = join(directory, 'cloud-bridge.mjs')
await build({
  stdin: {
    resolveDir: resolve('.'),
    contents: `
      export { REMOTE_FRONTEND_AUTH, remoteFrontendSessionPath } from './packages/protocol/src/index.ts'
      export { createPublishedFrontend } from './packages/web-server/src/published-frontend.ts'
      export { createCloudGateway } from './packages/cli/launch/cloud-gateway.ts'
    `,
  },
  outfile: bridgeOut,
  bundle: true,
  format: 'esm',
  target: 'node24',
  platform: 'node',
})
const { REMOTE_FRONTEND_AUTH, remoteFrontendSessionPath, createPublishedFrontend, createCloudGateway } =
  await import(pathToFileURL(bridgeOut).href)
const publication = await createPublishedFrontend({
  publication: {
    enabled: true,
    access: 'key-owner',
    auth: { keySha256: createHash('sha256').update(cloudKey).digest('hex') },
    host: '127.0.0.1',
    port: 0,
  },
  webOrigin,
  instanceId: 'fixture-cloud-B',
  wsUrl: () => webOrigin.replace('http:', 'ws:'),
  current: async () => true,
})
publicationOrigin = publication.url
const gateway = createCloudGateway(webOrigin)
const exchange = await fetch(`${publication.url}${REMOTE_FRONTEND_AUTH}`, {
  method: 'POST',
  body: JSON.stringify({ key: cloudKey }),
})
const grant = await exchange.json()
cloudSessionPath = remoteFrontendSessionPath(grant.token)
const sandboxOrigin = 'https://8443-fixture.ap-shanghai.tencentags.com'
gateway.register(sandboxOrigin, { ...grant, trafficToken: 'fixture-traffic-token' })
const cloudServer = createServer(async (request, response) => {
  if (await gateway.handleHttp(request, response)) return
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (path === '/') {
    response
      .writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      .end(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta id="agnes-config" data-backend-frame="cloud" data-parent-origin="${webOrigin}" data-remote="${sandboxOrigin}" data-cloud-token="${grant.token}" data-cloud-expires="${grant.expiresAt}"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/antd.css"><style>body { display:block; } #fixture-root { height:100dvh; min-width:0; }</style></head><body><div id="fixture-root"></div><script type="module" src="/fixture.js"></script></body></html>`,
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
  response
    .writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' })
    .end(
      path === '/tokens.css'
        ? readWebUiStyleSource(asset[0])
        : path === '/antd.css'
          ? inCssLayer(await readFile(asset[0], 'utf8'), 'vendor')
          : await readFile(asset[0]),
    )
})
await new Promise((done) => cloudServer.listen(0, '127.0.0.1', done))
cloudOrigin = `http://127.0.0.1:${cloudServer.address().port}`
console.log(`${webOrigin} cloud=${cloudOrigin} prefix=${remoteFrontendSessionPath(grant.token)}`)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    gateway.close()
    void publication
      .close()
      .finally(() =>
        cloudServer.close(() =>
          server.close(
            () => void rm(directory, { recursive: true, force: true }).then(() => process.exit(0)),
          ),
        ),
      )
  })
