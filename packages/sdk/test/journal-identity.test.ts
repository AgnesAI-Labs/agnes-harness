import { closeSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { afterEach, expect, it } from 'vitest'
import { fileJournal } from '../src/journal-file.node.js'
import { localStorageJournal } from '../src/journal-local-storage.js'

const dirs: string[] = []
function temporary() {
  const parent = mkdtempSync(join(tmpdir(), 'agnes-journal-identity-'))
  dirs.push(parent)
  return join(parent, 'journal')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('seeds new file state and rejects another identity without overwriting pending bytes', async () => {
  const dir = temporary()
  const a = fileJournal(dir, 'chosen-client')
  expect(await a.clientId()).toBe('chosen-client')
  expect(await a.nextCommandId('s')).toBe('chosen-client:s:1')
  await a.markPending('s', { commandId: 'c', method: 'submit', params: {} })
  const original = readFileSync(join(dir, 'journal.json'))
  await expect(fileJournal(dir, 'different-client').clientId()).rejects.toThrow(
    /^journal persistence unavailable$/,
  )
  expect(readFileSync(join(dir, 'journal.json'))).toEqual(original)
  expect(await fileJournal(dir, 'chosen-client').pending('s')).toHaveLength(1)
  expect(await fileJournal(dir).clientId()).toBe('chosen-client')
})
it('seeds browser storage and rejects identity mismatch without changing persisted state', async () => {
  const map = new Map<string, string>()
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  }
  const a = localStorageJournal(storage, 'test', 'chosen-client')
  expect(await a.clientId()).toBe('chosen-client')
  expect(await a.nextCommandId('s')).toBe('chosen-client:s:1')
  const original = map.get('test')
  await expect(localStorageJournal(storage, 'test', 'different-client').clientId()).rejects.toThrow(
    /^journal identity mismatch$/,
  )
  expect(map.get('test')).toBe(original)
  expect(await localStorageJournal(storage, 'test', 'chosen-client').nextCommandId('s')).toBe(
    'chosen-client:s:2',
  )
})

it('does not reset counters under a pinned identity when persistent state is corrupt', async () => {
  const dir = temporary()
  createPrivateDirectorySync(dir)
  const file = join(dir, 'journal.json')
  const fd = createPrivateFileSync(file)
  try {
    writeFileSync(fd, '{bad')
  } finally {
    closeSync(fd)
  }
  await expect(fileJournal(dir, 'pinned').nextCommandId('s')).rejects.toThrow(
    /^journal persistence unavailable$/,
  )
  expect(readFileSync(file, 'utf8')).toBe('{bad')
  let writes = 0
  const storage = {
    getItem: () => '{bad',
    setItem: () => {
      writes++
    },
  }
  await expect(localStorageJournal(storage, 'key', 'pinned').nextCommandId('s')).rejects.toThrow(
    /^invalid journal state$/,
  )
  expect(writes).toBe(0)
})
