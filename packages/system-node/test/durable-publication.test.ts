import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { publishFileDurablySync, removeFileDurablySync } from '../src/index.js'

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
