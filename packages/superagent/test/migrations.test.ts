import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  MIGRATIONS,
  type Migration,
  migrate,
  OLDEST_SCHEMA,
  SCHEMA_VERSION,
  tooOld,
} from '../src/app/migrations/index.js'
import { openStore } from '../src/app/store.js'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'migrations-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

it('records the current schema in a new database and reopens it', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const first = openStore(path)
  expect(first.get<number>('schema')).toBe(SCHEMA_VERSION)
  first.close()
  openStore(path).close()
})

it('refuses a database older than the oldest schema this build opens, and leaves it unchanged', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const old = new DatabaseSync(path)
  old.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  old.prepare('INSERT INTO kv VALUES (?,?)').run('schema', String(OLDEST_SCHEMA - 1))
  old.close()
  expect(() => openStore(path)).toThrow(tooOld(OLDEST_SCHEMA - 1))
  const again = new DatabaseSync(path)
  expect(again.prepare("SELECT value FROM kv WHERE key = 'schema'").get()?.value).toBe(
    String(OLDEST_SCHEMA - 1),
  )
  again.close()
})

it('does not open a database written by dsh-superagent (schema 10)', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const old = new DatabaseSync(path)
  old.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  old.prepare('INSERT INTO kv VALUES (?,?)').run('schema', '10')
  old.close()
  expect(() => openStore(path)).toThrow('schema 10 predates schema 11')
})

it('registers no migration yet: the first schema is the current one', () => {
  expect(MIGRATIONS).toEqual([])
})

it('runs the steps after the stored version in order, skips the ones already applied, and names a failing step', () => {
  const store = openStore(join(directory, 'orchestrator.sqlite'))
  const ran: number[] = []
  const step = (to: number, run: () => void = () => {}): Migration => ({
    to,
    run: () => {
      ran.push(to)
      run()
    },
  })
  const steps = [step(SCHEMA_VERSION - 1), step(SCHEMA_VERSION), step(SCHEMA_VERSION + 1)]
  migrate(store, SCHEMA_VERSION - 2, steps)
  expect(ran).toEqual([SCHEMA_VERSION - 1, SCHEMA_VERSION])
  ran.length = 0
  migrate(store, SCHEMA_VERSION - 1, steps)
  expect(ran).toEqual([SCHEMA_VERSION])
  expect(() =>
    migrate(store, SCHEMA_VERSION - 1, [
      step(SCHEMA_VERSION, () => {
        throw new Error('boom')
      }),
    ]),
  ).toThrow(`schema ${SCHEMA_VERSION}: boom`)
  store.close()
})
