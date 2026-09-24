import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createPrivateDirectorySync,
  createPrivateFileSync,
  hasPrivateDaclSync,
  renameWriteThroughSync,
  syncDirectorySync,
  syncFileSync,
} from '../src/index.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-system-中文 space%-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it('creates a private directory and exclusive file with a real Node-compatible descriptor', () => {
  const directory = join(root, 'private')
  createPrivateDirectorySync(directory)
  expect(hasPrivateDaclSync(directory)).toBe(true)
  const path = join(directory, 'secret.txt')
  const fd = createPrivateFileSync(path)
  try {
    writeFileSync(fd, '中文🙂 private data', 'utf8')
    fsyncSync(fd)
    expect(hasPrivateDaclSync(path)).toBe(true)
  } finally {
    closeSync(fd)
  }
  expect(readFileSync(path, 'utf8')).toBe('中文🙂 private data')
  expect(() => createPrivateFileSync(path)).toThrow(expect.objectContaining({ code: 'EEXIST' }))
  expect(() => createPrivateDirectorySync(directory)).toThrow(expect.objectContaining({ code: 'EEXIST' }))
  expect(readFileSync(path, 'utf8')).toBe('中文🙂 private data')
})
it('keeps native descriptors distinct from existing Node files and never writes into a different file', () => {
  const held: number[] = []
  let privateFd: number | undefined
  const privatePath = join(root, 'private.txt')
  try {
    for (let i = 0; i < 12; i++) {
      const fd = openSync(join(root, `held-${i}`), 'wx+')
      held.push(fd)
      writeFileSync(fd, `original-${i}`)
    }
    privateFd = createPrivateFileSync(privatePath)
    expect(held).not.toContain(privateFd)
    writeFileSync(privateFd, 'private 中文 content')
    fsyncSync(privateFd)
    expect(readFileSync(privatePath, 'utf8')).toBe('private 中文 content')
    for (const [i, fd] of held.entries()) {
      writeFileSync(fd, '-still-open')
      expect(readFileSync(join(root, `held-${i}`), 'utf8')).toBe(`original-${i}-still-open`)
    }
  } finally {
    if (privateFd !== undefined && !held.includes(privateFd)) closeSync(privateFd)
    for (const fd of held) closeSync(fd)
  }
})
it('flushes and replaces a file without changing its contents or private access', () => {
  const target = join(root, 'target.json'),
    temporary = join(root, 'stage.json')
  writeFileSync(target, 'old')
  const fd = createPrivateFileSync(temporary)
  try {
    writeFileSync(fd, '{"value":"中文"}')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncFileSync(temporary)
  renameWriteThroughSync(temporary, target)
  expect(existsSync(temporary)).toBe(false)
  expect(readFileSync(target, 'utf8')).toBe('{"value":"中文"}')
  expect(hasPrivateDaclSync(target)).toBe(true)
})
it('preserves both source and destination when replacement cannot succeed', () => {
  const source = join(root, 'source'),
    target = join(root, 'target')
  writeFileSync(source, 'preserve source')
  createPrivateDirectorySync(target)
  writeFileSync(join(target, 'child'), 'preserve destination')
  expect(() => renameWriteThroughSync(source, target)).toThrow()
  expect(readFileSync(source, 'utf8')).toBe('preserve source')
  expect(readFileSync(join(target, 'child'), 'utf8')).toBe('preserve destination')
})
it('supports long paths and rejects missing paths with a machine-readable error', () => {
  const first = join(root, 'a'.repeat(120)),
    second = join(first, 'b'.repeat(120))
  createPrivateDirectorySync(first)
  createPrivateDirectorySync(second)
  const file = join(second, '数据.txt')
  const fd = createPrivateFileSync(file)
  try {
    writeFileSync(fd, 'long path')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  expect(hasPrivateDaclSync(file)).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('long path')
  const renamed = join(second, '重命名.txt')
  renameWriteThroughSync(file, renamed)
  expect(readFileSync(renamed, 'utf8')).toBe('long path')
  expect(existsSync(file)).toBe(false)
  expect(() => syncFileSync(join(root, 'missing'))).toThrow(expect.objectContaining({ code: 'ENOENT' }))
})
it('does not represent directory synchronization as successful file synchronization', () => {
  expect(() => syncFileSync(root)).toThrow()
})
it('flushes a directory after file creation and removal and rejects ordinary files', () => {
  const path = join(root, 'entry')
  writeFileSync(path, 'contents', { flush: true })
  syncDirectorySync(root)
  expect(() => syncDirectorySync(path)).toThrow(expect.objectContaining({ code: 'ENOTDIR' }))
  rmSync(path)
  syncDirectorySync(root)
  expect(() => syncDirectorySync(join(root, 'missing'))).toThrow(expect.objectContaining({ code: 'ENOENT' }))
})
it.each(['relative.txt', 'bad\0path'])('rejects unusable input before creation: %s', (path) => {
  expect(() => createPrivateFileSync(path)).toThrow(expect.objectContaining({ code: 'EINVAL' }))
})
it.runIf(process.platform === 'win32')('native entry points reject missing or malformed paths', () => {
  const native = createRequire(import.meta.url)('@agnes/system-node/native')
  for (const name of [
    'createPrivateFile',
    'createPrivateDirectory',
    'hasPrivateDacl',
    'renameWriteThrough',
    'syncDirectory',
  ]) {
    expect(() => native[name]()).toThrow(expect.objectContaining({ code: 'EINVAL' }))
    expect(() => native[name](42, root)).toThrow(expect.objectContaining({ code: 'EINVAL' }))
  }
})
