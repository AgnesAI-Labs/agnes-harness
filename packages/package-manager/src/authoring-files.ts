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
export function authoringFiles(value: readonly AuthoringFile[]): AuthoringFile[] {
  let size = 0
  const seen = new Set<string>()
  if (!value.length || value.length > 64) authoringError('Candidate file limit exceeded')
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
      authoringError('Candidate file is invalid')
    const key = f.path.toLowerCase()
    if ([...seen].some((p) => p === key || p.startsWith(key + '/') || key.startsWith(p + '/')))
      authoringError('Candidate paths collide')
    seen.add(key)
    size += Buffer.byteLength(f.content)
  }
  if (size > 262144 || !value.some((f) => f.path === 'package.json'))
    authoringError('Candidate tree is invalid or too large')
  return value.map((f) => ({ ...f })).sort((a, b) => a.path.localeCompare(b.path))
}
export function writeAuthoringFiles(directory: string, files: readonly AuthoringFile[]): void {
  authoringDirectory(directory)
  const dirs = new Set([directory])
  for (const f of authoringFiles(files)) {
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
  return authoringFiles(result)
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
