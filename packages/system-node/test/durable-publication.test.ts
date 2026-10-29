import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { replacePublishedFileSync } from '../src/durable-replace.js'
import {
  mkdirDurablySync,
  publishFileDurablySync,
  removeFileDurablySync,
  syncTreeSync,
} from '../src/index.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'agh-durable-'))
  directories.push(path)
  return path
}

describe('durable file publication', () => {
  it('lets the first exclusive publisher win and leaves no temporary behind', () => {
    const root = directory(),
      file = join(root, 'record.json')
    expect(publishFileDurablySync(file, 'first')).toBe(true)
    expect(publishFileDurablySync(file, 'second')).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('first')
    expect(readdirSync(root)).toEqual(['record.json'])
  })

  it('replaces the destination only when asked and keeps it private', () => {
    const root = directory(),
      file = join(root, 'record.json')
    writeFileSync(file, 'old')
    expect(publishFileDurablySync(file, 'new', { replace: true })).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(readdirSync(root)).toEqual(['record.json'])
  })

  it('removes a file durably and treats a missing file or directory as removed', () => {
    const root = directory(),
      file = join(root, 'record.json')
    publishFileDurablySync(file, 'x')
    removeFileDurablySync(file)
    removeFileDurablySync(file)
    removeFileDurablySync(join(root, 'absent-directory', 'record.json'))
    expect(readdirSync(root)).toEqual([])
  })

  it('fails without publishing when the parent directory is missing', () => {
    const root = directory()
    expect(() => publishFileDurablySync(join(root, 'absent', 'record.json'), 'x')).toThrow()
    expect(readdirSync(root)).toEqual([])
  })
})

describe('durable directory chains', () => {
  it('creates every missing level below the anchor and tolerates existing ones', () => {
    const root = directory(),
      leaf = join(root, 'a', 'b', 'c')
    mkdirDurablySync(leaf, root)
    expect(existsSync(leaf)).toBe(true)
    mkdirDurablySync(leaf, root)
    mkdirDurablySync(join(root, 'a', 'b'), root)
  })

  it('never creates the anchor: a removed anchor is reported, not resurrected', () => {
    const root = directory(),
      anchor = join(root, 'generation')
    expect(() => mkdirDurablySync(join(anchor, 'adopters'), anchor)).toThrow(/ENOENT/)
    expect(existsSync(anchor)).toBe(false)
  })

  it('refuses a path outside its anchor and reports filesystem errors as they are', () => {
    const root = directory()
    expect(() => mkdirDurablySync(join(root, 'x'), join(root, 'elsewhere'))).toThrow(/not inside/)
    writeFileSync(join(root, 'file'), '')
    expect(() => mkdirDurablySync(join(root, 'file', 'child'), root)).toThrow(/ENOTDIR|EEXIST|ENOENT/)
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('')
    expect(existsSync(join(root, 'file', 'child'))).toBe(false)
  })

  it('flushes a whole tree, and a tree that is not a directory is an error', () => {
    const root = directory()
    mkdirSync(join(root, 'tree', 'nested'), { recursive: true })
    writeFileSync(join(root, 'tree', 'nested', 'file'), 'x')
    syncTreeSync(join(root, 'tree'))
    expect(() => syncTreeSync(join(root, 'missing'))).toThrow(/ENOENT/)
  })
})

describe('Windows replacement while a reader holds the destination', () => {
  const held = (code: string, forMs: number) => {
    const until = performance.now() + forMs
    let calls = 0
    return {
      rename: () => {
        calls++
        if (performance.now() < until)
          throw Object.assign(new Error(`${code}: MoveFileExW failed`), { code, win32Code: 5 })
      },
      calls: () => calls,
    }
  }

  it('retries the native EACCES (no syscall) until the reader lets go', () => {
    const reader = held('EACCES', 30)
    replacePublishedFileSync('a.tmp', 'a.json', true, reader.rename)
    expect(reader.calls()).toBeGreaterThan(1)
  })

  it('still refuses after the bound, off Windows, and for other errors', () => {
    for (const [windows, code, forMs] of [
      [true, 'EACCES', 60_000],
      [false, 'EACCES', 60_000],
      [true, 'ENOENT', 60_000],
    ] as const) {
      const reader = held(code, forMs)
      expect(() => replacePublishedFileSync('a.tmp', 'a.json', windows, reader.rename)).toThrow(code)
      if (!windows || code === 'ENOENT') expect(reader.calls()).toBe(1)
    }
  })
})
