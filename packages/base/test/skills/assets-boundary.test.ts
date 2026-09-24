import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectSkillFiles } from '../../extensions/skills/src/assets.js'
import type { SkillFs } from '../../extensions/skills/src/discover.js'

describe('Skill attachment canonical path boundaries', () => {
  const root = resolve('fixture-root')
  const directory = join(root, 'demo')
  const file = join(directory, 'scripts', 'demo.py')
  function fixture(realFile: string, bytes = new TextEncoder().encode('print("fixture")')) {
    let reads = 0
    const fs: SkillFs = {
      list: async (path) =>
        path === directory ? [{ name: 'scripts', kind: 'dir' }] : [{ name: 'demo.py', kind: 'file' }],
      realpath: async () => realFile,
      stat: async () => ({ kind: 'file', size: bytes.length, mtimeMs: 0 }),
      read: async () => {
        reads++
        return bytes
      },
    }
    return { fs, reads: () => reads }
  }
  it('accepts native platform paths without changing bytes', async () => {
    const s = fixture(file)
    const result = await collectSkillFiles(s.fs, directory, root)
    expect(result?.map((value) => value.relativePath)).toEqual(['scripts/demo.py'])
    expect(s.reads()).toBe(1)
  })
  it.each([join(`${root}-other`, 'demo.py'), resolve(root, '..', 'outside.py')])(
    'rejects an escaped canonical path before reading: %s',
    async (outside) => {
      const s = fixture(outside)
      expect(await collectSkillFiles(s.fs, directory, root)).toEqual([])
      expect(s.reads()).toBe(0)
    },
  )
  it.each([new Uint8Array([0xff]), new Uint8Array([0])])('rejects invalid script bytes', async (bytes) => {
    const s = fixture(file, bytes)
    expect(await collectSkillFiles(s.fs, directory, root)).toEqual([])
  })
})
