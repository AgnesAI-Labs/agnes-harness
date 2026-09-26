import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const fixture = resolve(import.meta.dirname)
const repo = resolve(fixture, '../../..')
const out = process.env.AGNES_XMD_OUT || '/private/tmp/agh-w5a0-browser'
await mkdir(resolve(out, 'vendor'), { recursive: true })
await build({
  entryPoints: [resolve(fixture, 'src/browser-entry.jsx')],
  outfile: resolve(out, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2023'],
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  // html-react-parser@5.2.17 advertises ESM but its ESM entry imports its CJS build,
  // which calls require('react'). Bind that one external require to the import-map React.
  banner: {
    js: "import * as __agnesSharedReact from 'react'; var require = (id) => { if (id === 'react') return __agnesSharedReact; throw Error('Unexpected external require: ' + id) };",
  },
  sourcemap: false,
  legalComments: 'eof',
})
await cp(resolve(repo, 'packages/web/dist/web/vendor'), resolve(out, 'vendor'), { recursive: true })
const [base, generated] = await Promise.all([
  readFile(resolve(repo, 'packages/web/public/style.css'), 'utf8'),
  readFile(resolve(out, 'app.css'), 'utf8'),
])
await writeFile(
  resolve(out, 'style.css'),
  `${base}\n${generated}\n.x-markdown.x-markdown-light,.x-markdown.x-markdown-dark{--text-color:var(--agnes-text-primary);--heading-color:var(--agnes-text-primary);--primary-color:var(--agnes-brand-primary);--light-bg:var(--agnes-bg-card);--border-color:var(--agnes-line-primary)}`,
)
await cp(resolve(repo, 'packages/web-ui/src/tokens.css'), resolve(out, 'tokens.css'))
await writeFile(
  resolve(out, 'index.html'),
  `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="agnes-csp-nonce" content="__AGNES_CSP_NONCE__">
<meta id="agnes-config" data-ws="__AGNES_WS_URL__">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/tokens.css">
<script type="importmap">{"imports":{"react":"/vendor/react.js","react/jsx-runtime":"/vendor/react-jsx-runtime.js","react-dom":"/vendor/react-dom.js","react-dom/client":"/vendor/react-dom-client.js","@agnes/web-ui/assistant-ui":"/vendor/assistant-ui.js"}}</script>
<script type="module" src="/app.js"></script></head>
<body>
<nav><button data-case="default-safety">Default safety</button><button data-case="adapted-safety">Adapted safety</button>
<button data-case="stream-start">Stream start</button><button data-case="stream-ref">Stream reference</button><button data-case="stream-final">Stream final</button>
<button data-case="syntax-start">Syntax start</button><button data-case="syntax-close">Syntax close</button><button data-case="replace-final">Final replace</button>
<button data-case="animation-start">Animation start</button><button data-case="animation-delta">Animation delta</button>
<button data-case="selection-delta">Selection delta</button><button data-case="selection-release">Selection release</button>
<button data-case="focus-delta">Focus delta</button><button data-case="focus-release">Focus release</button>
<button data-case="theme-dark">Toggle dark</button></nav>
<main id="root"></main><pre id="report"></pre>
</body></html>`,
)
console.log(out)
