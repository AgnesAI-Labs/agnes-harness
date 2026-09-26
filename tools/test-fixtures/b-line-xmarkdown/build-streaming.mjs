import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const fixture = resolve(import.meta.dirname)
const repo = resolve(fixture, '../../..')
const cliProbe = process.argv.includes('--cli')
const cliRoot = '/private/tmp/agh-w5b2-cli'
const assets = resolve(repo, 'packages/cli/dist/local/web')
const out = process.env.AGNES_XMD_STREAM_OUT || (cliProbe ? resolve(cliRoot, 'web') : '/private/tmp/agh-w5b1-streaming-browser')
if (cliProbe) await cp(resolve(repo, 'packages/cli/dist/local'), cliRoot, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await cp(assets, out, { recursive: true, force: true })
await build({
  entryPoints: [resolve(fixture, 'src/streaming-browser-entry.jsx')],
  outfile: resolve(out, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  target: ['es2023'],
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@agnes/cordis', '@agnes/web-client', '@agnes/web-ui/assistant-ui', 'antd'],
  legalComments: 'eof',
})
const original = await readFile(resolve(assets, 'index.html'), 'utf8')
const importMap = original.match(/<script type="importmap">[\s\S]*?<\/script>/)?.[0]
if (!importMap) throw new Error('Packaged import map missing')
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>W5b-2 streaming / animation probe</title>
<meta name="agnes-csp-nonce" content="__AGNES_CSP_NONCE__"><meta id="agnes-config" data-ws="__AGNES_WS_URL__">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/antd.css">
${importMap}<script type="module" src="/app.js"></script></head>
<body><nav><button id="delta">追加预览</button><button id="reconnect">重连</button><button id="complete">完成</button><button id="next">下一请求</button><button id="release">释放选区</button></nav>
<section id="transcript" tabindex="-1"></section><pre id="report"></pre></body></html>`
await Promise.all(['index.html', 'admin.html', 'resources.html'].map((page) => writeFile(resolve(out, page), html)))
console.log(out)
