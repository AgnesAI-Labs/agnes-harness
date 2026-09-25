import { cp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const antdCss = require.resolve('antd/dist/antd.css', { paths: [join(root, '..', 'web-ui')] })
const tokensCss = join(root, '..', 'web-ui', 'src', 'tokens.css')
const out = join(root, 'dist', 'web')
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
// WC5：平台共享单例说明符。宿主 app 与（未来的）插件模块都经 import map 解析到 /vendor/* 的
// 同一份实例；app.js 打包时保持这些说明符为外部导入。
const platformExternals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@agnes/cordis',
  '@agnes/web-client',
  'antd',
]
await build({
  entryPoints: {
    app: join(root, 'src', 'app.ts'),
    admin: join(root, 'src', 'admin', 'plugins', 'admin.ts'),
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
  external: platformExternals,
})
// WC5：平台共享单例 /vendor/*。React 入口与外部化 React 的 UI vendor 分开构建；React 的代码只
// 存在于共享入口/chunk 一份，antd、assistant-ui、web-client 经 import map 引用同一套 React 说明符。产物落在
// /vendor/ 命名空间，web-server 按固定文件名 + chunk 哈希模式放行。
const vendorOptions = {
  outdir: join(out, 'vendor'),
  outbase: join(root, 'tools', 'vendor'),
  bundle: true,
  splitting: true,
  format: 'esm' as const,
  platform: 'browser' as const,
  target: ['es2023'],
  sourcemap: true,
  entryNames: '[name]',
  chunkNames: 'chunk-[hash]',
}
await build({
  entryPoints: {
    react: join(root, 'tools', 'vendor', 'react-entry.js'),
    'react-jsx-runtime': join(root, 'tools', 'vendor', 'react-jsx-runtime-entry.js'),
    'react-dom': join(root, 'tools', 'vendor', 'react-dom-entry.js'),
    'react-dom-client': join(root, 'tools', 'vendor', 'react-dom-client-entry.js'),
  },
  ...vendorOptions,
})
await build({
  entryPoints: {
    antd: join(root, 'tools', 'vendor', 'antd-entry.js'),
    'assistant-ui': join(root, 'tools', 'vendor', 'assistant-ui-entry.js'),
    cordis: join(root, 'tools', 'vendor', 'cordis-entry.js'),
    'web-client': join(root, 'tools', 'vendor', 'web-client-entry.js'),
  },
  ...vendorOptions,
  external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'],
})
// 首帧主题必须用阻塞式 <script> 在 <head> 里跑完，早于第一次绘制。
// ESM 一律 defer，会闪一帧浅色，所以这一份单独打成 IIFE。
// CSP 是 script-src 'self' 无 unsafe-inline，内联脚本这条路走不通。
await build({
  entryPoints: { theme: join(root, 'src', 'theme-boot.ts') },
  outdir: out,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2023'],
  sourcemap: true,
})
await Promise.all(
  ['index.html', 'admin.html', 'resources.html', 'style.css', 'brand-mark.png']
    .map((file) => cp(join(root, 'public', file), join(out, file)))
    .concat([cp(antdCss, join(out, 'antd.css')), cp(tokensCss, join(out, 'tokens.css'))]),
)
