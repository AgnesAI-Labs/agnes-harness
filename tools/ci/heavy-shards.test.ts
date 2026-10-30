import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { heavyShard } from './run-heavy-shard.mjs'

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
