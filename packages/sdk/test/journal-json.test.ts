import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryJournal } from '../src/journal.js'
import { fileJournal } from '../src/journal-file.node.js'
import { localStorageJournal } from '../src/journal-local-storage.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const stores = [
  ['memory', () => memoryJournal()],
  [
    'file',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-journal-json-'))
      dirs.push(dir)
      return fileJournal(join(dir, 'journal'))
    },
  ],
  [
    'browser',
    () => {
      const data = new Map<string, string>()
      return localStorageJournal({
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
          data.set(key, value)
        },
      })
    },
  ],
] as const
for (const [name, create] of stores)
  describe(name, () => {
    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['undefined member', { value: undefined }],
      ['sparse array', Array(1)],
      ['Date', new Date(0)],
      ['Map', new Map([['key', 'value']])],
      ['bigint', 1n],
      ['symbol property', { [Symbol('key')]: 'value' }],
    ])(
      'rejects %s instead of silently changing the command and leaves prior pending intact',
      async (_label, params) => {
        const store = create()
        const original = { commandId: 'first', method: 'submit', params: { content: 'original' } }
        await store.markPending('s', original)
        await expect(store.markPending('s', { commandId: 'bad', method: 'submit', params })).rejects.toThrow(
          /^invalid journal state$/,
        )
        expect(await store.pending('s')).toEqual([original])
      },
    )
    it('never invokes payload getters/toJSON and rejects cycles with a fixed error', async () => {
      const store = create()
      const getter = vi.fn(() => 'private marker')
      const json = vi.fn(() => 'private marker')
      const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: getter })
      const cyclic: { self?: unknown } = {}
      cyclic.self = cyclic
      for (const params of [accessor, { toJSON: json }, cyclic])
        await expect(store.markPending('s', { commandId: 'bad', method: 'submit', params })).rejects.toThrow(
          /^invalid journal state$/,
        )
      expect(getter).not.toHaveBeenCalled()
      expect(json).not.toHaveBeenCalled()
      expect(await store.pending('s')).toEqual([])
    })
    it('preserves valid nested JSON and does not share nested returned objects', async () => {
      const store = create()
      const params = JSON.parse('{"__proto__":{"keep":true},"values":[null,false,0,"中😀"]}')
      await store.markPending('s', { commandId: 'ok', method: 'submit', params })
      const first = await store.pending('s')
      expect(first[0]?.params).toEqual(params)
      const nested = first[0]?.params as { values: unknown[] }
      nested.values[0] = 'changed'
      expect((await store.pending('s'))[0]?.params).toEqual(params)
    })
  })
