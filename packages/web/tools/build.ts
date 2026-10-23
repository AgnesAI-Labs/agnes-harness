import { appendFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BuildResult, build } from 'esbuild'
import { buildPresentations } from '../../../tools/presentation-build.mjs'
import { collectThirdPartyNotices } from '../../../tools/third-party-notices.mjs'
import { productionWebOptions } from '../../../tools/web-build-options.mjs'
import { clientPlatformExternals } from '../../../tools/web-client-externals.mjs'
import { scrollbarCsp } from '../../../tools/web-scrollbar-csp.mjs'
import {
  inCssLayer,
  readMarkdownThemeCss,
  readUiCss,
  readWebStyleSource,
  readWebUiStyleSource,
} from '../../../tools/web-style-source.mjs'
import { tabsAria } from '../../../tools/web-tabs-aria.mjs'
import { consumeVendorCss } from '../../../tools/web-vendor-css.mjs'
import { xSurface } from '../../../tools/web-x-surface.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const antdCss = require.resolve('antd/dist/antd.css', { paths: [join(root, '..', 'web-ui')] })
const tokensCss = join(root, '..', 'web-ui', 'src', 'tokens.css')
const conversationCss = join(root, '..', 'web-ui', 'src', 'conversation', 'messages.css')
const markdownOverridesCss = join(root, '..', 'web-ui', 'src', 'conversation', 'markdown.css')
const markdownLightCss = require.resolve('@ant-design/x-markdown/themes/light.css', {
  paths: [join(root, '..', 'web-ui')],
})
const markdownDarkCss = require.resolve('@ant-design/x-markdown/themes/dark.css', {
  paths: [join(root, '..', 'web-ui')],
})
const out = join(root, 'dist', 'web')

export async function buildWeb(
  options: { clean?: boolean; development?: boolean } = {},
): Promise<BuildResult[]> {
  await buildPresentations()
  if (options.clean !== false) await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  // Shared platform singleton specifiers: the host app and future plugin modules resolve through
  // the import map to the same /vendor/* instances; keep these imports external in app.js.
  const metafiles: BuildResult[] = []
  metafiles.push(
    await build({
      ...(options.development ? {} : productionWebOptions),
      absWorkingDir: root,
      define: { ...(options.development ? {} : productionWebOptions.define), __AGNES_WEB_BUNDLE__: 'true' },
      entryPoints: {
        app: join(root, 'src', 'bootstrap.ts'),
        admin: '@agnes/web-admin/admin/plugins/admin',
        resources: '@agnes/resource-control-web/admin',
        // 独立页宿主入口：设置弹窗里嵌的是 admin / resources（模块，由 app.ts 动态 import 后手动挂载）；
        // /admin/plugins 与 /admin/resources 两个整页加载这两个入口，由它们自己完成凭据交换与挂载。
        'admin-standalone': join(root, 'src', 'admin', 'plugins', 'standalone.ts'),
        'resources-standalone': '@agnes/resource-control-web/standalone',
      },
      outdir: out,
      bundle: true,
      format: 'esm',
      // 设置面板用动态 import() 懒加载 admin / resources；不开 splitting 时 esbuild 会把它们内联进
      // app.js（实测主包从 874KB 涨到 1074KB 且没有 chunk 产物）。开启后动态导入才真正变成按需 chunk。
      splitting: true,
      platform: 'browser',
      target: ['es2023'],
      sourcemap: true,
      // Bundle the offline diagnostics renderer while preserving the shared React imports.
      alias: { 'react-dom/server': require.resolve('react-dom/server.browser', { paths: [root] }) },
      banner: {
        js: "import __agnesSharedReact from 'react'; var require = (id) => { if (id === 'react') return __agnesSharedReact; throw Error('Unexpected external require: ' + id) };",
      },
      plugins: [clientPlatformExternals, scrollbarCsp],
      metafile: true,
    }),
  )
  // Shared /vendor/* singletons: build React entries separately from UI vendors that externalize React.
  // React code exists once in shared entries/chunks; antd, conversation and web-client reference the same React
  // specifiers through the import map. web-server allows fixed filenames and hashed chunks under /vendor/.
  const vendorOptions = {
    ...(options.development ? {} : productionWebOptions),
    outdir: join(out, 'vendor'),
    outbase: join(root, 'tools', 'vendor'),
    bundle: true,
    splitting: true,
    format: 'esm' as const,
    platform: 'browser' as const,
    target: ['es2023'],
    sourcemap: true,
    metafile: true,
    entryNames: '[name]',
    chunkNames: 'chunk-[hash]',
    define: { ...(options.development ? {} : productionWebOptions.define), __AGNES_WEB_BUNDLE__: 'true' },
  }
  metafiles.push(
    await build({
      absWorkingDir: root,
      entryPoints: {
        react: join(root, 'tools', 'vendor', 'react-entry.js'),
        'react-jsx-runtime': join(root, 'tools', 'vendor', 'react-jsx-runtime-entry.js'),
        'react-dom': join(root, 'tools', 'vendor', 'react-dom-entry.js'),
        'react-dom-client': join(root, 'tools', 'vendor', 'react-dom-client-entry.js'),
      },
      ...vendorOptions,
    }),
  )
  metafiles.push(
    await build({
      absWorkingDir: root,
      entryPoints: {
        antd: join(root, 'tools', 'vendor', 'antd-entry.js'),
        'antd-en-us': join(root, '..', 'web-ui', 'tools', 'antd-en-us.ts'),
        'antd-zh-cn': join(root, '..', 'web-ui', 'tools', 'antd-zh-cn.ts'),
        conversation: join(root, 'tools', 'vendor', 'conversation-entry.js'),
        x: join(root, 'tools', 'vendor', 'x-entry.js'),
        cordis: join(root, 'tools', 'vendor', 'cordis-entry.js'),
        'web-client': join(root, 'tools', 'vendor', 'web-client-entry.js'),
        'web-ui': join(root, 'tools', 'vendor', 'web-ui-entry.js'),
        protocol: join(root, 'tools', 'vendor', 'protocol-entry.js'),
        'sdk-browser': join(root, 'tools', 'vendor', 'sdk-browser-entry.js'),
        'web-units-shell': join(root, 'tools', 'vendor', 'web-units-shell-entry.js'),
        'web-locale-catalog': join(root, 'tools', 'vendor', 'web-locale-catalog-entry.js'),
        'goal-renderers': join(root, 'tools', 'vendor', 'goal-renderers-entry.js'),
        'interaction-renderer': join(root, 'tools', 'vendor', 'interaction-renderer-entry.js'),
        'presentation-renderers': join(root, 'tools', 'vendor', 'presentation-renderers-entry.js'),
      },
      ...vendorOptions,
      plugins: [scrollbarCsp, tabsAria, xSurface],
      external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'],
      // html-react-parser's ESM wrapper enters CJS and calls require('react'). Bind exactly that
      // call to the import-map singleton in every generated vendor chunk; reject other requires.
      banner: {
        js: "import * as __agnesSharedReact from 'react'; var require = (id) => { if (id === 'react') return __agnesSharedReact; throw Error('Unexpected external require: ' + id) };",
      },
    }),
  )
  // Optional chart assets import only the already-loaded React platform vendors.
  metafiles.push(
    await build({
      absWorkingDir: root,
      ...vendorOptions,
      entryPoints: {
        recharts: join(root, 'tools', 'vendor', 'recharts-entry.js'),
        'chunk-diagnostics': join(root, 'src', 'diagnostics-bundle.ts'),
      },
      splitting: false,
      alias: { 'react-dom/server': require.resolve('react-dom/server.browser', { paths: [root] }) },
      external: [
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom',
        'react-dom/client',
        '@agnes/web-ui',
      ],
      banner: {
        js: "import __agnesSharedReact from 'react'; var require = (id) => { if (id === 'react') return __agnesSharedReact; throw Error('Unexpected external require: ' + id) };",
      },
    }),
  )
  // 首帧主题必须用阻塞式 <script> 在 <head> 里跑完，早于第一次绘制。
  // ESM 一律 defer，会闪一帧浅色，所以这一份单独打成 IIFE。
  // CSP 是 script-src 'self' 无 unsafe-inline，内联脚本这条路走不通。
  metafiles.push(
    await build({
      ...(options.development ? {} : productionWebOptions),
      absWorkingDir: root,
      entryPoints: { theme: join(root, 'src', 'theme-boot.ts') },
      outdir: out,
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['es2023'],
      sourcemap: true,
      metafile: true,
    }),
  )
  await Promise.all(
    ['index.html', 'admin.html', 'resources.html', 'brand-mark.png', 'favicon.png']
      .map((file) => cp(join(root, 'public', file), join(out, file)))
      .concat([
        writeFile(join(out, 'antd.css'), inCssLayer(await readFile(antdCss, 'utf8'), 'vendor')),
        writeFile(join(out, 'tokens.css'), readWebUiStyleSource(tokensCss)),
      ]),
  )
  await writeFile(join(out, 'style.css'), readWebStyleSource(join(root, 'public', 'style.css')))
  // Conversation rules share the existing style.css URL on all three pages. The local CLI build
  // must apply the same composition when copying Web assets into its own static root.
  await appendFile(join(out, 'style.css'), `\n${readUiCss(conversationCss)}`)
  await appendFile(
    join(out, 'style.css'),
    `\n${readUiCss(join(root, '..', 'web-ui', 'src', 'intelligent-ui', 'styles.css'))}`,
  )
  // esbuild emits this CSS companion because XMarkdown imports its core stylesheet. All pages
  // already load /style.css, so merge core + published themes + Agnes overrides there.
  const core = await consumeVendorCss(join(out, 'vendor'))
  const [light, dark, overrides] = await Promise.all([
    Promise.resolve(readMarkdownThemeCss(markdownLightCss)),
    Promise.resolve(readMarkdownThemeCss(markdownDarkCss)),
    Promise.resolve(readUiCss(markdownOverridesCss)),
  ])
  await appendFile(
    join(out, 'style.css'),
    `\n${inCssLayer(`${core}\n${light}\n${dark}`, 'vendor')}\n${overrides}`,
  )
  await collectThirdPartyNotices(root, out, metafiles)
  return metafiles
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWeb()
