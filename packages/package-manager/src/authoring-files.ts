import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { AuthoringFile } from '@agnes/protocol'
import {
  createPrivateDirectorySync,
  createPrivateFileSync,
  renameWriteThroughSync,
  syncDirectorySync,
} from '@agnes/system-node'
import { requireCompleteCandidate } from './authoring-diagnostics.js'
import { PackageError } from './errors.js'

export const authoringHash = (value: string) => 'sha256-' + createHash('sha256').update(value).digest('hex')
export function authoringError(message: string): never {
  throw new PackageError('E_LOCK_MISMATCH', message, { code: 'E_PACKAGE_PREVIEW_STALE' })
}
export function authoringDirectory(directory: string): void {
  if (existsSync(directory)) {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) authoringError('Candidate storage is unsafe')
  } else {
    authoringDirectory(dirname(directory))
    createPrivateDirectorySync(directory)
  }
}
export function authoringFiles(value: readonly AuthoringFile[], draft = false): AuthoringFile[] {
  const invalid = (message: string): never => {
    throw new PackageError('E_DEP_MISSING', message)
  }
  let size = 0
  const seen = new Set<string>()
  if ((!draft && !value.length) || value.length > 64) invalid('Candidate file limit exceeded')
  for (const f of value) {
    if (
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(f.path) ||
      f.path.length > 240 ||
      f.path
        .split('/')
        .some(
          (p) =>
            ['.', '..', 'node_modules', '.git', 'fixtures'].includes(p) ||
            p.endsWith('.') ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
        ) ||
      f.content.includes('\0') ||
      Buffer.byteLength(f.content) > 131072
    )
      invalid('Candidate file is invalid')
    const key = f.path.toLowerCase()
    if ([...seen].some((p) => p === key || p.startsWith(key + '/') || key.startsWith(p + '/')))
      invalid('Candidate paths collide')
    seen.add(key)
    size += Buffer.byteLength(f.content)
  }
  if (size > 262144) invalid('Candidate tree is too large')
  if (!draft && !value.some((f) => f.path === 'package.json')) requireCompleteCandidate(value)
  return value.map((f) => ({ ...f })).sort((a, b) => a.path.localeCompare(b.path))
}
/** Merge deltas before the ordinary full-tree validation; never mutate the saved tree in place. */
export function authoringWriteFiles(
  current: readonly AuthoringFile[],
  files: readonly AuthoringFile[],
  mode: 'replace' | 'merge' = 'replace',
  remove: readonly string[] = [],
): AuthoringFile[] {
  const refusal = (
    code: 'conflicting-write-path' | 'missing-remove-path' | 'invalid-field',
    path: string,
  ): never => {
    throw new PackageError('E_DEP_MISSING', 'Candidate write delta is invalid', {
      detail: { diagnostics: [{ code, path, field: 'remove', name: path }] },
    })
  }
  if (mode !== 'merge') {
    if (mode !== 'replace' || remove.length) refusal('invalid-field', 'package.json')
    return authoringFiles(files, true)
  }
  const edits = authoringFiles(files, true)
  authoringFiles(
    remove.map((path) => ({ path, content: '' })),
    true,
  )
  const next = new Map(current.map((file) => [file.path, file]))
  for (const path of remove) {
    if (edits.some((file) => file.path.toLowerCase() === path.toLowerCase()))
      refusal('conflicting-write-path', path)
    if (!next.delete(path)) refusal('missing-remove-path', path)
  }
  for (const file of edits) next.set(file.path, file)
  return authoringFiles([...next.values()], true)
}
export function writeAuthoringFiles(directory: string, files: readonly AuthoringFile[]): void {
  authoringDirectory(directory)
  const dirs = new Set([directory])
  for (const f of authoringFiles(files, true)) {
    const target = join(directory, f.path)
    authoringDirectory(dirname(target))
    for (let d = dirname(target); d !== directory; d = dirname(d)) dirs.add(d)
    const fd = createPrivateFileSync(target)
    try {
      writeFileSync(fd, f.content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) syncDirectorySync(d)
}
export function readAuthoringFiles(directory: string): AuthoringFile[] {
  const result: AuthoringFile[] = []
  const walk = (root: string, prefix: string) => {
    if (prefix.length > 240) authoringError('Candidate path is too long')
    if (lstatSync(root).isSymbolicLink()) authoringError('Candidate tree contains a symbolic link')
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(entry.name)) continue
      const path = join(root, entry.name),
        name = prefix + entry.name
      if (entry.isDirectory()) walk(path, name + '/')
      else if (entry.isFile() && lstatSync(path).size <= 131072) {
        const bytes = readFileSync(path)
        result.push({ path: name, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })
      } else authoringError('Candidate tree contains unsafe or oversized files')
      if (result.length > 64) authoringError('Candidate file limit exceeded')
    }
  }
  walk(directory, '')
  return authoringFiles(result, true)
}
export function saveAuthoringRecord(file: string, value: unknown): void {
  authoringDirectory(dirname(file))
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()))
    authoringError('Candidate record is unsafe')
  const temp = file + '.' + randomUUID() + '.tmp',
    fd = createPrivateFileSync(temp)
  try {
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameWriteThroughSync(temp, file)
  syncDirectorySync(dirname(file))
}
