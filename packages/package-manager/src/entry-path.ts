import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PackageError } from './errors.js'

const MANIFEST_FILE = 'agnes.extension.json'
function fail(file: string, why: string, detail: Record<string, unknown> = {}): never {
  throw new PackageError('E_EXT_LOAD', `${file}: ${why}`, { detail: { file, ...detail } })
}
export function containedEntry(dir: string, entry: string, kind: 'file' | 'directory', file: string): string {
  const reason = kind === 'file' ? 'entry-escape' : 'bad-package'
  if (
    !entry ||
    isAbsolute(entry) ||
    /[\\:]/.test(entry) ||
    entry.includes('\0') ||
    entry.split('/').includes('..')
  )
    fail(file, 'entry escapes the directory or is not a portable relative path', { reason })
  let root: string
  let target: string
  try {
    root = realpathSync(dir)
    target = realpathSync(resolve(root, entry))
    if (!statSync(root).isDirectory()) throw new Error('root type')
    const stat = statSync(target)
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new Error('target type')
  } catch {
    fail(file, 'entry cannot be resolved to the required filesystem type', { reason })
  }
  const rel = relative(root, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    fail(file, 'entry escapes the directory', { reason })
  return target
}

export function resolveEntry(dir: string, entry: string): string {
  return containedEntry(dir, entry, 'file', join(dir, MANIFEST_FILE))
}
