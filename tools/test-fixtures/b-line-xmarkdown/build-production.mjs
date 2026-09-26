import { cp, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const fixture = resolve(import.meta.dirname)
const repo = resolve(fixture, '../../..')
const out = process.env.AGNES_XMD_PROD_OUT || '/private/tmp/agh-w5a-production-browser'
await mkdir(out, { recursive: true })
await cp(resolve(repo, 'packages/cli/dist/local/web'), out, { recursive: true, force: true })
await build({
  entryPoints: [resolve(fixture, 'src/production-browser-entry.jsx')],
  outfile: resolve(out, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  target: ['es2023'],
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@agnes/web-ui/assistant-ui'],
  legalComments: 'eof',
})
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>W5a production probe</title>
<meta name="agnes-csp-nonce" content="__AGNES_CSP_NONCE__"><meta id="agnes-config" data-ws="__AGNES_WS_URL__">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/tokens.css">
<script type="importmap">{"imports":{"react":"/vendor/react.js","react/jsx-runtime":"/vendor/react-jsx-runtime.js","react-dom":"/vendor/react-dom.js","react-dom/client":"/vendor/react-dom-client.js","@agnes/web-ui/assistant-ui":"/vendor/assistant-ui.js"}}</script>
<script type="module" src="/app.js"></script></head>
<body><main id="probe-root"></main><pre id="report"></pre></body></html>`
await Promise.all(['index.html', 'admin.html', 'resources.html'].map((page) => writeFile(resolve(out, page), html)))
console.log(out)
