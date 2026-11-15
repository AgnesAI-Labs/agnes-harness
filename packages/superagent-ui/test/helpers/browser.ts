/**
 * Serve the panel to a real browser the way the AGH page does: the host stylesheets, the stylesheets the shipped
 * client descriptor declares (wrapped in the `app` layer as the web server wraps them), the page's CSP, and the panel
 * mounted in a home page host. `browser-entry.tsx` holds the panel side.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { inCssLayer, readWebStyleSource, readWebUiStyleSource } from '../../../../tools/web-style-source.mjs'
import { tabsAria } from '../../../../tools/web-tabs-aria.mjs'
import type { Scenario } from './browser-entry.js'

export type { Scenario }

const root = resolve(import.meta.dirname, '../../../..')
const webUi = createRequire(join(root, 'packages/web-ui/package.json'))
/** The part of esbuild's API this file uses; esbuild is resolved from the web-ui package, which depends on it. */
interface PluginBuild {
  onResolve(
    filter: { filter: RegExp },
    run: (args: { path: string }) => { path: string; namespace: string },
  ): void
  onLoad(
    filter: { filter: RegExp; namespace: string },
    run: (args: { path: string }) => { loader: 'js'; contents: string },
  ): void
}
type Build = (options: Record<string, unknown>) => Promise<{ outputFiles: { path: string; text: string }[] }>
const { build } = webUi('esbuild') as { build: Build }
const ORIGIN = 'http://agh.test'
const NONCE = 'superagent-panel-test'
/** The page's policy: styles only from the server or under the page's nonce, scripts only from the server. */
export const PAGE_CSP = `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'nonce-${NONCE}'; script-src 'self'`
const descriptor = join(root, 'packages/package-manager/bundled-plugins/superagent/src/agnes.client.json')

/** The stylesheets the shipped descriptor names, read from their source in this package. */
export function panelStyles(): { path: string; text: string }[] {
  const styles = (JSON.parse(readFileSync(descriptor, 'utf8')) as { client: { styles?: string[] } }).client
    .styles
  return (styles ?? []).map((path) => ({
    path: `/plugins/superagent/${path.replace(/^\.\//, '')}`,
    text: readFileSync(join(root, 'packages/superagent-ui/src', path), 'utf8'),
  }))
}

const hostCss = () =>
  [
    readWebStyleSource(join(root, 'packages/web/public/style.css')),
    inCssLayer(readFileSync(webUi.resolve('antd/dist/antd.css'), 'utf8'), 'vendor'),
    readWebUiStyleSource(join(root, 'packages/web-ui/src/tokens.css')),
    // The shell around a home page: the main area is a column and the page host scrolls.
    'html, body { height: 100%; margin: 0; } body { display: block; }',
    'main[data-home-page] { display: flex; flex-direction: column; height: 100vh; }',
  ].join('\n')

/** The packaged files the fake services read (prompts, skills, locale), keyed by their path in a virtual package. */
function packagedFiles(): Record<string, string> {
  const base = join(root, 'packages/superagent')
  const files: Record<string, string> = {}
  for (const folder of ['prompts', 'skills', 'locale'])
    for (const entry of readdirSync(join(base, folder), { recursive: true, withFileTypes: true }))
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name)
        files[`/superagent/${relative(base, path).replaceAll('\\', '/')}`] = readFileSync(path, 'utf8')
      }
  return files
}
/** Stand-ins for what the fake services import but a browser lacks: the test runner and a read-only file system. */
const NODE_STUBS: Record<string, string> = {
  vitest: 'export const beforeEach = () => {}, afterEach = () => {}, expect = () => ({ toEqual() {} })',
  'node:url': "export const fileURLToPath = (url) => String(url).replace(/^file:\\/\\//, '')",
  'node:path': `export const delimiter = ':'
export const isAbsolute = (path) => path.startsWith('/')
export const join = (...parts) => parts.join('/').replace(/\\/+/g, '/').split('/').reduce((out, part) => (part === '..' ? out.slice(0, -1) : part === '.' ? out : [...out, part]), []).join('/') || '/'
export const dirname = (path) => path.replace(/\\/[^/]*$/, '') || '/'
export const basename = (path) => path.replace(/^.*\\//, '')
export const resolve = (...parts) => join(...parts)`,
  // Ids only need to be stable within the page, not cryptographic.
  'node:crypto': `export const randomUUID = () => crypto.randomUUID()
export const createHash = () => {
  let text = ''
  const hash = { update: (part) => ((text += String(part)), hash), digest: () => {
    let out = ''
    for (let round = 0; out.length < 64; round++) {
      let value = 2166136261 ^ round
      for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619)
      out += (value >>> 0).toString(16).padStart(8, '0')
    }
    return out
  } }
  return hash
}`,
  'node:fs': `const files = __PACKAGED_FILES__
export const constants = {}
export const accessSync = () => {}
export const realpathSync = (path) => path
export const statSync = () => ({ isDirectory: () => false })
export const existsSync = (path) => Object.keys(files).some((name) => name === path || name.startsWith(path + '/'))
export const readFileSync = (path) => {
  if (path in files) return files[path]
  throw Object.assign(new Error('ENOENT: ' + path), { code: 'ENOENT' })
}`,
}
const browserStubs = {
  name: 'browser-stubs',
  setup(builder: PluginBuild) {
    builder.onResolve({ filter: /^(vitest|node:.*)$/ }, ({ path }) => ({ path, namespace: 'stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({
      loader: 'js',
      contents:
        NODE_STUBS[path]?.replace('__PACKAGED_FILES__', JSON.stringify(packagedFiles())) ??
        // Anything else may be imported but must not be called in the page.
        `module.exports = new Proxy({}, { get: (_, key) => key === '__esModule' ? false : () => { throw new Error('${path} is not in a browser') } })`,
    }))
  },
}

let bundle: Promise<string> | undefined
export function panelBundle(): Promise<string> {
  if (bundle) return bundle
  bundle = build({
    entryPoints: [join(root, 'packages/superagent-ui/test/helpers/browser-entry.tsx')],
    outfile: join(root, 'packages/superagent-ui/panel.js'),
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: {
      'process.env.NODE_ENV': '"production"',
      // The fake services find the packaged folders from the module's own address.
      'import.meta.url': JSON.stringify('file:///superagent/src/app/skill-files.ts'),
    },
    logLevel: 'error',
    plugins: [tabsAria, browserStubs],
  }).then((result) => {
    const output = result.outputFiles.find((file) => file.path.endsWith('.js'))
    if (!output) throw new Error('No panel bundle')
    return output.text
  })
  return bundle
}

export interface Opened {
  /** Policy violations the page reported, such as a stylesheet the CSP refused. */
  violations: string[]
}
/** Open the panel for one scenario; `styles: false` leaves out the descriptor's stylesheets. */
export async function openPanel(
  page: Page,
  scenario: Scenario,
  { theme = 'light', styles = true }: { theme?: 'light' | 'dark'; styles?: boolean } = {},
): Promise<Opened> {
  const sheets = styles ? panelStyles() : []
  const files: Record<string, { type: string; body: string }> = {
    '/host.css': { type: 'text/css', body: hostCss() },
    '/scenario.js': {
      type: 'text/javascript',
      body: `window.superagentScenario = ${JSON.stringify(scenario)}`,
    },
    '/panel.js': { type: 'text/javascript', body: await panelBundle() },
    ...Object.fromEntries(
      sheets.flatMap(({ path, text }) => [
        [path, { type: 'text/css', body: text }],
        // What the page loads: the web server answers the layered form with an import into the `app` layer.
        [
          `${path}?agnes_css_layer=app`,
          { type: 'text/css', body: `@import url(${JSON.stringify(path)}) layer(app);\n` },
        ],
      ]),
    ),
    '/': {
      type: 'text/html',
      body: `<!doctype html>
<html lang="${scenario.language}"${theme === 'dark' ? ' class="dark"' : ''}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="agnes-csp-nonce" content="${NONCE}" />
<title>Superagent</title>
<link rel="stylesheet" href="/host.css" />
${sheets.map(({ path }) => `<link rel="stylesheet" href="${path}?agnes_css_layer=app" />`).join('\n')}
</head>
<body>
<main data-home-page="superagent"><div id="home-page-host" class="home-page-host"></div></main>
<script src="/scenario.js"></script>
<script src="/panel.js"></script>
</body>
</html>`,
    },
  }
  const opened: Opened = { violations: [] }
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url())
    const file = files[`${url.pathname}${url.search}`]
    if (!file) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({
      status: 200,
      contentType: file.type,
      headers: url.pathname === '/' ? { 'Content-Security-Policy': PAGE_CSP } : {},
      body: file.body,
    })
  })
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) opened.violations.push(message.text())
  })
  await page.goto(`${ORIGIN}/`)
  return opened
}
