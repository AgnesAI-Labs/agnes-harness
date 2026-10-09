import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { VENDOR_ENTRY_NAMES } from './vendor-assets.js'

export const DEFAULT_WEB_PORT = 4177
export const WORKSPACE_PICKER_PATH = '/api/workspace-picker'
export const PLAN_MODE_PATH = '/api/plan-mode'
export const PLAN_MODE_BODY_LIMIT = 64 * 1024
export const HOST = '127.0.0.1'
export const FILES = new Set([
  'index.html',
  'admin.html',
  'resources.html',
  'theme.js',
  'theme.js.map',
  'app.js',
  'app.js.map',
  'admin.js',
  'admin.js.map',
  'admin-standalone.js',
  'admin-standalone.js.map',
  'resources.js',
  'resources.js.map',
  'resources-standalone.js',
  'resources-standalone.js.map',
  'style.css',
  'antd.css',
  'tokens.css',
  // 侧栏品牌位与过程行头像共用的客户端 AgnesMark 位图。白名单仍然逐文件放行
  // （不放宽成任意 .png），它由 packages/web/public 随 style.css 一起拷进发行目录。
  'brand-mark.png',
])
export const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.map': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
}
// Skin assets are a separate namespace from the build artifacts above: their extension allowlist is
// the same one the installer enforces, so an unknown extension is refused here rather than sniffed.
export const SKIN_MIME: Record<string, string> = {
  '.css': 'text/css',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}
// Client module assets (`/plugins/*`) are executable code and styles served to the page, so their
// extension allowlist is narrower than the skins one: exactly the module entry, its stylesheet and
// source maps. An unknown extension is refused here rather than sniffed.
export const CLIENT_MODULE_MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
}

/** WC5：index.html 内联 import map 脚本体（<script type="importmap"> 与 </script> 之间的精确字节）
 *  的 SHA-256，供 CSP script-src 以哈希放行。文件缺失或无 import map 时返回 undefined（fail-closed）。 */
export async function importMapScriptHash(root: string): Promise<string | undefined> {
  let html: string
  try {
    html = await readFile(join(root, 'index.html'), 'utf8')
  } catch {
    return undefined
  }
  const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)
  if (!match) return undefined
  const body = match?.[1]
  if (!body) return undefined
  return createHash('sha256').update(body, 'utf8').digest('base64')
}

export function fileName(requestUrl: string): string {
  let pathname: string
  try {
    pathname = new URL(requestUrl, 'http://127.0.0.1').pathname
  } catch {
    throw new Error('invalid Web request path')
  }
  const file =
    pathname === '/'
      ? 'index.html'
      : pathname === '/admin/plugins' || pathname === '/admin/plugins/'
        ? 'admin.html'
        : pathname === '/admin/resources' || pathname === '/admin/resources/'
          ? 'resources.html'
          : // URL paths use forward slashes on every OS; disk paths are joined only when reading.
            posix.normalize(pathname).replace(/^[/\\]+/, '')
  // esbuild 的 splitting 会为动态 import() 产出带哈希的共享 chunk。它们与入口同为同源静态资源，
  // 所以用固定模式放行，而不是把路径校验放宽成任意文件。
  const isChunk = /^chunk-[A-Za-z0-9_-]+\.(?:js|css)(\.map)?$/.test(file)
  // WC5：/vendor/* 平台共享单例命名空间——入口文件名固定（import map 的映射目标），共享 chunk
  // 走 chunk- 哈希模式；命名空间内不允许任意文件，不放宽成目录列举。
  const vendorEntry = /^vendor\/([a-z0-9-]+)\.js(?:\.map)?$/.exec(file)?.[1]
  const isVendor =
    (vendorEntry !== undefined && VENDOR_ENTRY_NAMES.has(vendorEntry)) ||
    /^vendor\/chunk-[A-Za-z0-9_-]+\.js(\.map)?$/.test(file)
  if (!(FILES.has(file) || isChunk || isVendor) || file.includes('..')) throw new Error('Web asset not found')
  return file
}
