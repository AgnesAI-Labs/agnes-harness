import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { heavyShard, migratedHeavyFiles } from './run-heavy-shard.mjs'

const { lists } = JSON.parse(readFileSync(new URL('./heavy-shards.json', import.meta.url), 'utf8')) as {
  lists: string[][]
}

it('names existing heavy files once each, and leaves every other heavy file to the last shard', () => {
  const count = lists.length + 1
  for (let index = 1; index < count; index++)
    expect(heavyShard(`${index}/${count}`, lists)).toEqual({ files: lists[index - 1] })
  expect(heavyShard(`${count}/${count}`, lists)).toEqual({ exclude: lists.flat() })
})

it('refuses a wrong shard count, a duplicate entry and a file that is not heavy', () => {
  expect(() => heavyShard('1/2', [['a.e2e.test.ts'], ['b.e2e.test.ts']], () => true)).toThrow(/k\/3/)
  expect(() => heavyShard('1/3', [['a.e2e.test.ts'], ['a.e2e.test.ts']], () => true)).toThrow(/more than one/)
  expect(() => heavyShard('1/2', [['a.test.ts']], () => true)).toThrow(/not a heavy test file/)
  expect(() => heavyShard('1/2', [['a.e2e.test.ts']], () => false)).toThrow(/not a heavy test file/)
})

it('keeps all migrated heavy selections and follows their current owners', () => {
  const files = Object.keys(
    JSON.parse(readFileSync(new URL('./heavy-migrations.json', import.meta.url), 'utf8')),
  )
  expect(migratedHeavyFiles(files)).toEqual(files)
  expect(files).toHaveLength(66)
  expect(files).toContain('packages/daemon/test/channel-pipe-real.e2e.test.ts')
  expect(files).toContain('packages/host-infrastructure/test/git-worktrees.e2e.test.ts')
  expect(files).toContain('packages/web/test/plugin-admin-page.slow.test.ts')
})

it('rejects missing, non-heavy and duplicate migration selections before starting Vitest', () => {
  expect(() => migratedHeavyFiles(['missing.e2e.test.ts'])).toThrow(/not a heavy test file/)
  expect(() => migratedHeavyFiles(['a.test.ts'], () => true)).toThrow(/not a heavy test file/)
  expect(() => migratedHeavyFiles(['a.e2e.test.ts', 'a.e2e.test.ts'], () => true)).toThrow(/more than once/)
  expect(() => migratedHeavyFiles([])).toThrow(/empty/)
})
