import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectSkillFiles } from '../../extensions/skills/src/assets.js'
import type { SkillFs } from '../../extensions/skills/src/discover.js'
import {
  collectPackageSkillFiles,
  decodePackageSkillFiles,
} from '../../extensions/skills/src/package-assets.js'

describe('Skill attachment canonical path boundaries', () => {
  it('roundtrips real package attachments and rejects damaged private transport', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agh-skill-assets-'))
    try {
      await mkdir(join(directory, 'references'))
      await writeFile(join(directory, 'references', 'example.md'), '中文\r\nreference')
      await writeFile(join(directory, 'SKILL.md'), 'not an attachment')
      await writeFile(join(directory, 'ignore.exe'), 'unsupported')
      const stored = await collectPackageSkillFiles(directory)
      expect(stored).toHaveLength(1)
      expect(Buffer.from(decodePackageSkillFiles(stored)?.[0]?.bytes ?? []).toString('utf8')).toBe(
        '中文\r\nreference',
      )
      expect(decodePackageSkillFiles(undefined)).toBeUndefined()
      const first = stored[0]
      for (const damaged of [
        null,
        [...stored, ...stored],
        [{ ...first, relativePath: '../escape.md' }],
        [{ ...first, sha256: '0'.repeat(64) }],
        [{ ...first, content: `${first?.content}\n` }],
        [{ ...first, kind: 'binary' }],
        [{ ...first, mime: 'text/html' }],
      ]) {
        expect(() => decodePackageSkillFiles(damaged)).toThrow('invalid package Skill attachments')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
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
    await expect(collectSkillFiles(s.fs, directory, root, { complete: true })).rejects.toThrow(
      'incomplete Skill attachments',
    )
  })
  it('rejects incomplete package snapshots while keeping unsupported files optional', async () => {
    const s = fixture(file)
    await expect(
      collectSkillFiles(
        {
          ...s.fs,
          list: async () => {
            throw new Error('private')
          },
        },
        directory,
        root,
        { complete: true },
      ),
    ).rejects.toMatchObject({ code: 'SKILL_ATTACHMENTS_UNREADABLE' })
    await expect(
      collectSkillFiles(
        {
          ...s.fs,
          read: async () => {
            throw new Error('private')
          },
        },
        directory,
        root,
        { complete: true },
      ),
    ).rejects.toMatchObject({ code: 'SKILL_ATTACHMENTS_UNREADABLE' })
    await expect(
      collectSkillFiles(
        {
          ...s.fs,
          list: async () =>
            Array.from({ length: 33 }, (_, i) => ({ name: `${i}.md`, kind: 'file' as const })),
        },
        directory,
        root,
        { complete: true },
      ),
    ).rejects.toMatchObject({ code: 'SKILL_ATTACHMENTS_LIMIT' })
    await expect(
      collectSkillFiles(
        { ...s.fs, stat: async () => ({ kind: 'file', size: 256 * 1024 + 1, mtimeMs: 0 }) },
        directory,
        root,
        { complete: true },
      ),
    ).rejects.toMatchObject({ code: 'SKILL_ATTACHMENTS_LIMIT' })
    expect(
      await collectSkillFiles(
        {
          ...s.fs,
          list: async () =>
            Array.from({ length: 32 }, (_, i) => ({ name: `${i}.md`, kind: 'file' as const })),
        },
        directory,
        root,
        { complete: true },
      ),
    ).toHaveLength(32)
    expect(
      await collectSkillFiles(
        { ...s.fs, list: async () => [{ name: 'ignore.exe', kind: 'file' }] },
        directory,
        root,
        { complete: true },
      ),
    ).toEqual([])
  })
})
