import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, posix, relative, resolve, sep } from 'node:path'
import {
  CLIENT_ASSET_EXTENSIONS,
  CLIENT_MAX_FILE_BYTES,
  CLIENT_MAX_TOTAL_BYTES,
  CLIENT_RESOURCE_MAX_FILE_BYTES,
  CLIENT_RESOURCE_MAX_TOTAL_BYTES,
} from '@agnes/package-manager'
import { init as initModuleLexer, parse as parseModule } from 'es-module-lexer'
export const SERVABLE = new Set(CLIENT_ASSET_EXTENSIONS.map((extension) => `.${extension}`))
export function cleanRelative(path: string): string | undefined {
  const normalized = path.startsWith('./') ? path.slice(2) : path
  if (
    normalized === '' ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    return undefined
  return normalized
}

async function referencedAssets(path: string, bytes: Buffer): Promise<string[]> {
  const extension = extname(path).toLowerCase()
  if (extension !== '.js' && extension !== '.mjs' && extension !== '.css') return []
  const text = bytes.toString('utf8')
  const rawReferences: string[] = []
  for (const match of text.matchAll(/[#@]\s*sourceMappingURL=([^\s*]+)/g))
    if (match[1]) rawReferences.push(match[1])
  if (extension === '.css') {
    // Comments cannot contribute CSS dependencies. Removing them prevents a commented-out url()
    // from turning a valid package into resources-invalid.
    const css = text.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const pattern of [
      /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?/g,
      /url\(\s*["']?([^"')]+)["']?\s*\)/g,
    ])
      for (const match of css.matchAll(pattern)) if (match[1]) rawReferences.push(match[1])
  } else {
    await initModuleLexer
    const [imports] = parseModule(text)
    for (const imported of imports) if (imported.n !== undefined) rawReferences.push(imported.n)
    // Asset URLs are not ESM imports, but the supported build output may use this standard form.
    const codeWithoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const match of codeWithoutComments.matchAll(
      /new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
    ))
      if (match[1]) rawReferences.push(match[1])
  }
  const references: string[] = []
  for (const reference of rawReferences) {
    const raw = reference.split(/[?#]/, 1)[0]
    if (!raw?.startsWith('.')) continue
    const candidate = posix.normalize(posix.join(posix.dirname(path), raw))
    if (cleanRelative(candidate) === candidate && SERVABLE.has(extname(candidate).toLowerCase()))
      references.push(candidate)
  }
  return references
}

export async function collectSnapshotFiles(
  packageDirectory: string,
  roots: readonly string[],
): Promise<Map<string, Buffer> | null> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(packageDirectory)
  } catch {
    return null
  }
  const queue = [...new Set(roots)]
  const files = new Map<string, Buffer>()
  let total = 0
  let codeTotal = 0
  while (queue.length) {
    const path = queue.shift()
    if (!path || files.has(path)) continue
    if (cleanRelative(path) !== path || !SERVABLE.has(extname(path).toLowerCase())) return null
    let target: string
    let info: import('node:fs').Stats
    try {
      target = await realpath(resolve(canonicalRoot, path))
      const rel = relative(canonicalRoot, target)
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null
      info = await stat(target)
    } catch {
      return null
    }
    if (
      !info.isFile() ||
      info.size >
        (/\.(?:js|mjs|css|map)$/.test(path) ? CLIENT_MAX_FILE_BYTES : CLIENT_RESOURCE_MAX_FILE_BYTES)
    )
      return null
    const bytes = await readFile(target)
    if (
      bytes.length >
      (/\.(?:js|mjs|css|map)$/.test(path) ? CLIENT_MAX_FILE_BYTES : CLIENT_RESOURCE_MAX_FILE_BYTES)
    )
      return null
    total += bytes.length
    if (/\.(?:js|mjs|css|map)$/.test(path)) codeTotal += bytes.length
    if (total > CLIENT_RESOURCE_MAX_TOTAL_BYTES || codeTotal > CLIENT_MAX_TOTAL_BYTES) return null
    files.set(path, bytes)
    queue.push(...(await referencedAssets(path, bytes)))
  }
  return files.size ? files : null
}
