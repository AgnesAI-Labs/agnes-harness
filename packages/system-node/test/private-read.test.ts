import { execFileSync } from 'node:child_process'
import { closeSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createPrivateDirectorySync,
  createPrivateFileSync,
  windowsOpenPrivateFileSync,
  windowsReadPrivateFileSync,
} from '../src/index.js'

describe.runIf(process.platform === 'win32')('same-handle Windows private reads', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agnes-private-read-中文 space%-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
  function file(contents = 'PRIVATE-DATA-中文🙂'): string {
    const path = join(root, 'private')
    const fd = createPrivateFileSync(path)
    try {
      writeFileSync(fd, contents)
    } finally {
      closeSync(fd)
    }
    return path
  }
  it('returns exact bytes up to the limit, including an empty file', () => {
    const text = 'PRIVATE-DATA-中文🙂',
      path = file(text)
    expect(windowsReadPrivateFileSync(path, Buffer.byteLength(text))).toEqual(Buffer.from(text))
    expect(() => windowsReadPrivateFileSync(path, Buffer.byteLength(text) - 1)).toThrow(
      expect.objectContaining({ code: 'EFBIG' }),
    )
    rmSync(path)
    expect(windowsReadPrivateFileSync(file(''), 0)).toEqual(Buffer.alloc(0))
  })
  it('opens a private journal larger than the bounded secret reader limit using a Node descriptor', () => {
    const path = file('initial')
    const content = Buffer.alloc(17 * 1024 * 1024, 65)
    writeFileSync(path, content)
    const held: number[] = []
    let fd: number | undefined
    try {
      for (let i = 0; i < 12; i++) {
        const other = createPrivateFileSync(join(root, `held-${i}`))
        held.push(other)
        writeFileSync(other, `other-${i}`)
      }
      fd = windowsOpenPrivateFileSync(path)
      expect(readFileSync(fd).equals(content)).toBe(true)
      expect(() => writeFileSync(path, 'replacement')).toThrow()
      expect(() => renameSync(path, join(root, 'moved'))).toThrow()
    } finally {
      if (fd !== undefined) closeSync(fd)
      for (const other of held) closeSync(other)
    }
    for (let i = 0; i < 12; i++) expect(readFileSync(join(root, `held-${i}`), 'utf8')).toBe(`other-${i}`)
    writeFileSync(path, 'after-close')
    expect(readFileSync(path, 'utf8')).toBe('after-close')
  })
  it('rejects files with another hard link, without returning content or its path', () => {
    const path = file()
    linkSync(path, join(root, 'alias'))
    expect(() => closeSync(windowsOpenPrivateFileSync(path))).toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    )
    try {
      windowsReadPrivateFileSync(path, 1024)
      throw new Error('unexpected success')
    } catch (error) {
      expect(error).toMatchObject({ code: 'EACCES' })
      expect(String(error)).not.toContain(root)
      expect(String(error)).not.toContain('PRIVATE-DATA')
    }
  })
  it('refuses a file with public read access', () => {
    const path = file(),
      systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error('SystemRoot missing')
    execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [path, '/grant', '*S-1-1-0:R'], {
      windowsHide: true,
      stdio: 'pipe',
    })
    expect(() => windowsReadPrivateFileSync(path, 1024)).toThrow(expect.objectContaining({ code: 'EACCES' }))
    expect(() => closeSync(windowsOpenPrivateFileSync(path))).toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    )
  })
  it('refuses a simultaneously open writer and releases the read handle before returning', () => {
    const path = file(),
      fd = createPrivateFileSync(join(root, 'writer'))
    try {
      writeFileSync(fd, 'held')
      expect(() => windowsReadPrivateFileSync(join(root, 'writer'), 1024)).toThrow(
        expect.objectContaining({ code: 'EBUSY' }),
      )
    } finally {
      closeSync(fd)
    }
    expect(windowsReadPrivateFileSync(join(root, 'writer'), 1024).toString()).toBe('held')
    windowsReadPrivateFileSync(path, 1024)
    rmSync(path)
  })
  it('rejects directories and missing files', () => {
    const path = join(root, 'directory')
    createPrivateDirectorySync(path)
    expect(() => windowsReadPrivateFileSync(path, 1024)).toThrow(expect.objectContaining({ code: 'EACCES' }))
    expect(() => windowsReadPrivateFileSync(join(root, 'missing'), 1024)).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    )
  })
  it.each([-1, NaN, 1.5, 16777217])('rejects invalid size limit %s', (maximum) => {
    expect(() => windowsReadPrivateFileSync(join(root, 'missing'), maximum)).toThrow(
      expect.objectContaining({ code: 'EINVAL' }),
    )
  })
})
