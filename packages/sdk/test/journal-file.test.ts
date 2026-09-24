import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  closeSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateDirectorySync, createPrivateFileSync, hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, expect, it } from 'vitest'
import { fileJournal } from '../src/journal-file.node.js'

const dirs: string[] = []
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-journal-'))
  dirs.push(dir)
  const root = join(dir, 'journal')
  createPrivateDirectorySync(root)
  return root
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('persists identity, counters, cursors and pending across interleaved instances', async () => {
  const dir = temporary()
  const a = fileJournal(dir)
  const b = fileJournal(dir)
  const id = await a.clientId()
  expect(await b.clientId()).toBe(id)
  expect(await a.nextCommandId('s')).toBe(`${id}:s:1`)
  expect(await b.nextCommandId('s')).toBe(`${id}:s:2`)
  expect(await a.nextCommandId('s')).toBe(`${id}:s:3`)
  await a.setCursor('s', { fromSeq: 9, generation: 2 })
  const cmd = { commandId: 'c', method: 'submit', params: { text: 'saved' } }
  await b.markPending('s', cmd)
  cmd.params.text = 'changed'
  const fresh = fileJournal(dir)
  expect(await fresh.cursor('s')).toEqual({ fromSeq: 9, generation: 2 })
  expect(await fresh.pending('s')).toEqual([{ commandId: 'c', method: 'submit', params: { text: 'saved' } }])
  await fresh.clearPending('s', 'c')
  expect(await a.pending('s')).toEqual([])
  for (const name of ['journal.json', 'journal-lock.db'])
    if (process.platform === 'win32') expect(hasPrivateDaclSync(join(dir, name))).toBe(true)
    else expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600)
  expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
})
it.each(['{bad', '{"clientId":"old"}', '{"clientId":"old","counters":{"s":-1},"cursors":{},"pending":{}}'])(
  'preserves corrupt bytes before creating fresh state: %s',
  async (raw) => {
    const dir = temporary()
    closeSync(createPrivateFileSync(join(dir, 'journal.json')))
    writeFileSync(join(dir, 'journal.json'), raw, { mode: 0o600 })
    const id = await fileJournal(dir).clientId()
    expect(id).toMatch(/^[a-f0-9]{32}$/)
    const archived = readdirSync(dir).filter((name) => name.startsWith('journal.json.corrupt-'))
    expect(archived).toHaveLength(1)
    expect(readFileSync(join(dir, archived[0] ?? ''), 'utf8')).toBe(raw)
    expect(await fileJournal(dir).clientId()).toBe(id)
  },
)
it.runIf(process.platform !== 'win32')(
  'rejects a linked journal without modifying its target or inventing a fresh identity',
  async () => {
    const dir = temporary()
    const target = join(dir, 'target')
    writeFileSync(target, 'private-marker', { mode: 0o600 })
    symlinkSync(target, join(dir, 'journal.json'))
    await expect(fileJournal(dir).clientId()).rejects.toThrow(/^journal persistence unavailable$/)
    expect(readFileSync(target, 'utf8')).toBe('private-marker')
    expect(readdirSync(dir).some((name) => name.includes('corrupt'))).toBe(false)
  },
)
it('refuses concurrent lock ownership and resumes from durable state after release', async () => {
  const dir = temporary()
  const journal = fileJournal(dir)
  const id = await journal.clientId()
  const db = new DatabaseSync(join(dir, 'journal-lock.db'))
  db.exec('BEGIN EXCLUSIVE')
  try {
    await expect(journal.nextCommandId('s')).rejects.toThrow(/^journal persistence unavailable$/)
  } finally {
    db.exec('ROLLBACK')
    db.close()
  }
  expect(await journal.nextCommandId('s')).toBe(`${id}:s:1`)
})
it('handles prototype-named session keys as ordinary owned entries', async () => {
  const j = fileJournal(temporary())
  const id = await j.clientId()
  for (const key of ['__proto__', 'constructor', 'toString']) {
    expect(await j.nextCommandId(key)).toBe(`${id}:${key}:1`)
    await j.setCursor(key, { fromSeq: 1, generation: 1 })
    expect(await j.cursor(key)).toEqual({ fromSeq: 1, generation: 1 })
  }
})

it('releases the real cross-process lock when its holder is killed', async () => {
  const dir = temporary()
  const journal = fileJournal(dir)
  const id = await journal.clientId()
  const child = spawn(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '-e',
      "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); process.stdout.write('ready'); process.stdin.resume()",
      join(dir, 'journal-lock.db'),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const closed = once(child, 'close')
  try {
    const ready = await Promise.race([
      once(child.stdout, 'data'),
      closed.then(() => {
        throw new Error('lock holder exited early')
      }),
    ])
    expect(String(ready[0])).toBe('ready')
    await expect(journal.nextCommandId('s')).rejects.toThrow(/^journal persistence unavailable$/)
    child.kill('SIGKILL')
    await closed
    expect(await journal.nextCommandId('s')).toBe(`${id}:s:1`)
  } finally {
    child.kill('SIGKILL')
    await closed
  }
})
