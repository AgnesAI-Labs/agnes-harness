import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { memoryJournal } from '../src/journal.js'
import { fileJournal } from '../src/journal-file.node.js'
import { localStorageJournal } from '../src/journal-local-storage.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function stores(id: string) {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-command-id-'))
  dirs.push(dir)
  const map = new Map<string, string>()
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  }
  return {
    list: [memoryJournal(id), fileJournal(join(dir, 'journal'), id), localStorageJournal(storage, 'key', id)],
    reopen: () => [fileJournal(join(dir, 'journal'), id), localStorageJournal(storage, 'key', id)],
  }
}
it('preserves the 128-code-point boundary, including astral Unicode', async () => {
  for (const session of ['x'.repeat(124), '😀'.repeat(124)]) {
    for (const store of stores('c').list) {
      const value = await store.nextCommandId(session)
      expect(value).toBe(`c:${session}:1`)
      expect(Array.from(value)).toHaveLength(128)
    }
  }
})
it('generates matching bounded IDs across stores and resumes the durable counter', async () => {
  const id = 'c'.repeat(128)
  const session = 's'.repeat(512)
  const s = stores(id)
  const first = await Promise.all(s.list.map((store) => store.nextCommandId(session)))
  expect(new Set(first).size).toBe(1)
  expect(first[0]).toMatch(/^sha256-[0-9a-f]{64}-1$/)
  expect(first[0]?.length).toBeLessThanOrEqual(128)
  for (const store of s.reopen())
    expect(await store.nextCommandId(session)).toBe(first[0]?.replace(/-1$/, '-2'))
  const other = await s.list[0]?.nextCommandId(`${session}x`)
  expect(other).not.toBe(first[0])
})
it('allocates concurrent long-form command IDs before asynchronous hashing', async () => {
  for (const store of stores('c'.repeat(128)).list) {
    const ids = await Promise.all(Array.from({ length: 10 }, () => store.nextCommandId('s')))
    expect(new Set(ids).size).toBe(10)
    expect(ids.map((id) => Number(id.slice(id.lastIndexOf('-') + 1)))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
  }
})
