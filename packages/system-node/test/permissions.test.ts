import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createPrivateDirectorySync,
  createPrivateFileSync,
  hasPrivateDaclSync,
  syncDirectorySync,
  windowsEnsurePrivateDirectorySync,
  windowsProtectPrivateDirectorySync,
  windowsReadPrivateTextSync,
} from '../src/index.js'

let root: string

it.runIf(process.platform === 'win32')('reads private UTF-8 text while retaining the byte limit', () => {
  const path = join(root, 'text')
  const fd = createPrivateFileSync(path)
  try {
    writeFileSync(fd, '中文\n')
  } finally {
    closeSync(fd)
  }
  expect(windowsReadPrivateTextSync(path, 7)).toBe('中文\n')
  expect(() => windowsReadPrivateTextSync(path, 6)).toThrow()
  expect(readFileSync(path, 'utf8')).toBe('中文\n')
})

it.runIf(process.platform === 'win32')(
  'creates missing directory levels privately without changing an existing ancestor',
  () => {
    const before = acl(root)
    const parent = join(root, 'new'),
      target = join(parent, 'nested')
    windowsEnsurePrivateDirectorySync(target)
    expect(hasPrivateDaclSync(parent)).toBe(true)
    expect(hasPrivateDaclSync(target)).toBe(true)
    windowsEnsurePrivateDirectorySync(target)
    expect(acl(root)).toEqual(before)
  },
)

it.runIf(process.platform === 'win32')('refuses a broad existing target without changing its ACL', () => {
  const target = join(root, 'broad')
  mkdirSync(target)
  acl(target, '/grant', '*S-1-1-0:R')
  const before = acl(target)
  expect(() => windowsEnsurePrivateDirectorySync(target)).toThrow()
  expect(acl(target)).toEqual(before)
})

it.runIf(process.platform === 'win32')(
  'refuses a junction ancestor while creating missing directories',
  () => {
    const target = join(root, 'target'),
      alias = join(root, 'alias')
    createPrivateDirectorySync(target)
    symlinkSync(target, alias, 'junction')
    try {
      expect(() => windowsEnsurePrivateDirectorySync(join(alias, 'child'))).toThrow()
    } finally {
      unlinkSync(alias)
    }
  },
)
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-acl-中文 space%-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function acl(path: string, ...args: string[]): Buffer {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('SystemRoot is required for the Windows ACL test')
  return execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [path, ...args], {
    windowsHide: true,
    stdio: 'pipe',
  })
}

it.each(['file', 'directory'])(
  'rejects a %s after access is widened and accepts it after removal',
  (kind) => {
    const path = join(root, kind)
    if (kind === 'file') closeSync(createPrivateFileSync(path))
    else createPrivateDirectorySync(path)
    expect(hasPrivateDaclSync(path)).toBe(true)
    if (process.platform === 'win32') acl(path, '/grant', '*S-1-1-0:R')
    else chmodSync(path, kind === 'file' ? 0o644 : 0o755)
    expect(hasPrivateDaclSync(path)).toBe(false)
    if (process.platform === 'win32') acl(path, '/remove:g', '*S-1-1-0')
    else chmodSync(path, kind === 'file' ? 0o600 : 0o700)
    expect(hasPrivateDaclSync(path)).toBe(true)
  },
)

it.runIf(process.platform === 'win32')('rejects an unprotected inherited DACL', () => {
  const path = join(root, 'private')
  createPrivateDirectorySync(path)
  expect(hasPrivateDaclSync(path)).toBe(true)
  acl(path, '/inheritance:e')
  expect(hasPrivateDaclSync(path)).toBe(false)
})

it.runIf(process.platform === 'win32')(
  'protects an existing private directory without changing children or content',
  () => {
    const parent = join(root, 'parent'),
      existing = join(parent, 'existing')
    createPrivateDirectorySync(parent)
    mkdirSync(existing)
    const child = join(existing, 'child')
    writeFileSync(child, 'keep child')
    const before = acl(child)
    expect(hasPrivateDaclSync(existing)).toBe(false)
    windowsProtectPrivateDirectorySync(existing)
    expect(hasPrivateDaclSync(existing)).toBe(true)
    expect(acl(child)).toEqual(before)
    expect(readFileSync(child, 'utf8')).toBe('keep child')
    windowsProtectPrivateDirectorySync(existing)
    expect(acl(child)).toEqual(before)
  },
)

it.runIf(process.platform === 'win32')(
  'refuses to adopt broad directory permissions without changing them',
  () => {
    acl(root, '/grant', '*S-1-1-0:R')
    const before = acl(root)
    expect(() => windowsProtectPrivateDirectorySync(root)).toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    )
    expect(acl(root)).toEqual(before)
  },
)

it.runIf(process.platform === 'win32')('refuses to protect files or directory junctions', () => {
  const file = join(root, 'file'),
    target = join(root, 'target'),
    link = join(root, 'link')
  closeSync(createPrivateFileSync(file))
  createPrivateDirectorySync(target)
  symlinkSync(target, link, 'junction')
  try {
    expect(() => windowsProtectPrivateDirectorySync(file)).toThrow(
      expect.objectContaining({ code: 'ENOTDIR' }),
    )
    expect(() => windowsProtectPrivateDirectorySync(link)).toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    )
    expect(hasPrivateDaclSync(target)).toBe(true)
  } finally {
    unlinkSync(link)
  }
})

it('rejects a directory link and never changes the linked target during exclusive creation', () => {
  const target = join(root, 'target'),
    link = join(root, 'link')
  createPrivateDirectorySync(target)
  writeFileSync(join(target, 'keep'), 'preserved')
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    expect(hasPrivateDaclSync(target)).toBe(true)
    expect(hasPrivateDaclSync(link)).toBe(false)
    expect(() => syncDirectorySync(link)).toThrow()
    expect(() => createPrivateDirectorySync(link)).toThrow(expect.objectContaining({ code: 'EEXIST' }))
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('preserved')
    expect(hasPrivateDaclSync(target)).toBe(true)
  } finally {
    unlinkSync(link)
  }
})

it('reports missing objects instead of treating them as private', () => {
  expect(() => hasPrivateDaclSync(join(root, 'missing'))).toThrow(expect.objectContaining({ code: 'ENOENT' }))
})

it.runIf(process.platform === 'win32')(
  'propagates denied directory write access instead of skipping flush',
  () => {
    const path = join(root, 'private')
    createPrivateDirectorySync(path)
    syncDirectorySync(path)
    acl(path, '/deny', '*S-1-1-0:W')
    try {
      expect(() => syncDirectorySync(path)).toThrow(expect.objectContaining({ code: 'EACCES' }))
    } finally {
      acl(path, '/remove:d', '*S-1-1-0')
    }
    syncDirectorySync(path)
  },
)
