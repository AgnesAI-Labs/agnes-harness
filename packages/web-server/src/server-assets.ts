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
  // Client AgnesMark bitmap shared by the sidebar brand and process-row avatars. Keep the per-file allowlist;
  // do not allow arbitrary .png files. Copy it from packages/web/public into the distribution alongside style.css.
  'brand-mark.png',
  // The browser-tab icon: the brand mark in its own blue on an off-white tile, so it reads on
  // light and dark tab strips alike. The mask above is white-on-transparent and cannot serve as one.
  'favicon.png',
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
// Client code and declared scene resources use fixed MIME types. The daemon snapshot enforces
// path, hash and size admission; unknown formats are refused here rather than sniffed.
export const CLIENT_MODULE_MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.map': 'application/json',
}

/**
 * SHA-256 of the inline index.html import map body: the exact bytes between <script type="importmap"> and </script>.
 * CSP script-src allows it by hash. Return undefined if the file or map is missing (fail-closed).
 */
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
  if (pathname === '/favicon.ico') return 'favicon.png'
  const file =
    pathname === '/'
      ? 'index.html'
      : pathname === '/admin/plugins' || pathname === '/admin/plugins/'
        ? 'admin.html'
        : pathname === '/admin/resources' || pathname === '/admin/resources/'
          ? 'resources.html'
          : // URL paths use forward slashes on every OS; disk paths are joined only when reading.
            posix.normalize(pathname).replace(/^[/\\]+/, '')
  // esbuild names shared chunks chunk-<hash> and lazy entries <module>-<hash>.
  // Accept either generated name, without allowing arbitrary scripts or nested paths.
  const isChunk = /^[A-Za-z0-9_-]+-[A-Z0-9]{8}\.(?:js|css)(\.map)?$/.test(file)
  // /vendor/* is the shared platform singleton namespace: entry names are fixed import-map targets; shared chunks
  // use the chunk- hash pattern. Do not allow arbitrary files or directory listings in this namespace.
  const vendorEntry = /^vendor\/([a-z0-9-]+)\.js(?:\.map)?$/.exec(file)?.[1]
  const isVendor =
    (vendorEntry !== undefined && VENDOR_ENTRY_NAMES.has(vendorEntry)) ||
    /^vendor\/chunk-[A-Za-z0-9_-]+\.js(\.map)?$/.test(file)
  if (!(FILES.has(file) || isChunk || isVendor) || file.includes('..')) throw new Error('Web asset not found')
  return file
}
