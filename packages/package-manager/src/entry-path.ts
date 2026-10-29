import { statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { safeAuthoringDiagnostics } from '@agnes/error-sanitization'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { PackageError } from './errors.js'

const MANIFEST_FILE = 'package.json'
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
    root = nativeRealpathSync(dir)
    target = nativeRealpathSync(resolve(root, entry))
    if (!statSync(root).isDirectory()) throw new Error('root type')
    const stat = statSync(target)
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new Error('target type')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const diagnostics = safeAuthoringDiagnostics([
        { code: 'missing-required-file', path: 'package.json', field: 'entry', name: entry },
      ])
      if (diagnostics.length)
        throw new PackageError('E_EXT_LOAD', 'Required package file is missing', {
          detail: { file, reason, diagnostics },
        })
    }
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
