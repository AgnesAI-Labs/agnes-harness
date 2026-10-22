import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
