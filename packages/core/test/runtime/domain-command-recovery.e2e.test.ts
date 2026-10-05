import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { CallContext } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { type DomainCommandStorage, fail } from '../../src/runtime/projection/commands.js'
import {
  createProjectionProvider,
  type NativeConversation,
  type ProjectionAccess,
  type ProjectionDomain,
} from '../../src/runtime/providers/projection.js'

/**
 * This file is also the child process: with CHILD set it opens the projection over a SQLite command
 * store, does one step, and can stop dead at a marked point so the parent kills it there. The shared
 * projection suite's six scenarios for this default provider run in the official acceptance runner
 * (tools/acceptance/runtime/client/projection-conformance.e2e.test.ts).
 */
const CHILD = 'AGH_DOMAIN_COMMAND_RECOVERY_CHILD'
const NO_READS = {
  query: async () => fail('unsupported', 'no selector reads in this test'),
  resolveData: async () => fail('unsupported', 'no selector reads in this test'),
}
const SESSION = 'recovery'
const TASK = 'recovery-task'
const REQUEST = 'recovery-rename'
const BINDING = {
  bindingId: 'recovery',
  contract: 'agh.projection',
  logicalName: 'tasks',
  providerId: 'default',
}

type Fixture = {
  domain: ProjectionDomain & { commandStateSchema: Wire.SchemaRef }
  gate: ProjectionAccess
  native: NativeConversation
  turnOf(event: Wire.DomainEvent): string | null
  prepared(): number
}

/** The shared suite lives outside this package's build, so it is loaded by URL. Only what is used is typed. */
type Suite = {
  createProjectionFixture(): Fixture
  domainEvent(
    eventId: string,
    type: string,
    sessionId: string,
    payload: Record<string, string>,
  ): Wire.DomainEvent
  callContext(): CallContext
  listQuery(sessionId: string, limit: number): Wire.DomainQuery
  renameRequest(viewId: string, viewRevision: number, requestId: string, expectedRevision: number): unknown
}
const loadSuite = async () =>
  (await import(
    new URL('../../../extension-api/testkit/runtime/contracts/projection.ts', import.meta.url).href
  )) as Suite

/** Writes a mark and blocks this thread until the parent kills the process. */
function stopAt(mark: string): void {
  writeSync(1, `${mark}\n`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
}

const identityOf = (event: Pick<Wire.DomainEvent, 'scope' | 'source' | 'typeId' | 'idempotencyKey'>) =>
  canonicalJsonDigest([event.scope, event.source, event.typeId, event.idempotencyKey])

function sqliteStorage(db: DatabaseSync, point: string): DomainCommandStorage {
  const row = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as T | undefined
  return {
    async transaction(body) {
      db.exec('BEGIN IMMEDIATE')
      let accepted = false
      try {
        const result = body({
          command: (key) => {
            const found = row<{ body: string }>('SELECT body FROM commands WHERE key = ?', key)
            return found ? JSON.parse(found.body) : undefined
          },
          putCommand(command) {
            if (point === 'inside') stopAt('INSIDE')
            db.prepare('INSERT INTO commands (key, body) VALUES (?, ?)').run(
              command.key,
              JSON.stringify(command),
            )
            accepted = true
          },
          state: () =>
            JSON.parse(
              row<{ body: string }>('SELECT body FROM state')?.body ?? '{"value":null,"revision":0}',
            ),
          putState: (state) =>
            void db
              .prepare(
                'INSERT INTO state (one, body) VALUES (1, ?) ON CONFLICT(one) DO UPDATE SET body = excluded.body',
              )
              .run(JSON.stringify(state)),
          lastSequence: () =>
            row<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events')?.seq ?? 0,
          eventByIdentity: (identity) =>
            (db.prepare('SELECT record FROM events ORDER BY seq').all() as { record: string }[])
              .map((found) => JSON.parse(found.record) as Wire.DomainEventRecord)
              .find(({ event }) => identityOf(event) === identityOf(identity)),
          putEvent: (record) =>
            void db
              .prepare('INSERT INTO events (seq, record) VALUES (?, ?)')
              .run(record.sequence, JSON.stringify(record)),
          putDispatch: (dispatch) =>
            void db
              .prepare('INSERT INTO dispatches (command_id, key, body) VALUES (?, ?, ?)')
              .run(dispatch.commandId, dispatch.key, JSON.stringify(dispatch)),
          dispatches: (commandId) =>
            (
              db.prepare('SELECT key FROM dispatches WHERE command_id = ?').all(commandId) as {
                key: string
              }[]
            ).map((found) => ({ key: found.key, ack: null })),
        })
        db.exec('COMMIT')
        // Only the transaction that accepted the command; earlier ones are the replay lookup.
        if (point === 'after' && accepted) stopAt('COMMITTED')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

function openStorage(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commands (key TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS state (one INTEGER PRIMARY KEY CHECK (one = 1), body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dispatches (command_id TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (command_id, key));
  `)
  return db
}

const record = (event: Wire.DomainEvent, sequence: number): Wire.DomainEventRecord => ({
  event,
  authorityId: 'recovery-authority',
  sequence,
  aggregate: {
    authorityId: 'recovery-authority',
    typeId: 'conformance.tasks/board@1',
    id: 'board',
    revision: sequence,
  },
  fingerprint: canonicalJsonDigest(event.eventId),
})

/** The default provider over one SQLite connection, as one process opens it. */
function openDefault(db: DatabaseSync, fixture: Fixture, point = 'none', domain = fixture.domain) {
  return createProjectionProvider({
    binding: BINDING,
    reads: NO_READS,
    domain,
    access: fixture.gate,
    native: fixture.native,
    turnOf: fixture.turnOf,
    journal: async (after, limit) =>
      (
        db.prepare('SELECT record FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit) as {
          record: string
        }[]
      ).map((found) => JSON.parse(found.record) as Wire.DomainEventRecord),
    owner: {
      namespace: 'conformance.tasks',
      authorityId: 'recovery-authority',
      aggregate: { typeId: 'conformance.tasks/board@1', id: 'board' },
      source: BINDING,
      stateSchema: fixture.domain.commandStateSchema,
      destination: 'runtime-inbox',
      storage: sqliteStorage(db, point),
      clock: { now: () => '2026-10-01T00:00:00Z', newId: () => randomUUID() },
    },
  })
}

async function child(step: string, database: string, point: string): Promise<void> {
  const suite = await loadSuite()
  const fixture = suite.createProjectionFixture()
  const db = openStorage(database)
  if (step === 'seed') {
    const event = suite.domainEvent('recovery-added', 'added', SESSION, {
      taskId: TASK,
      board: 'open',
      title: 'Before',
    })
    db.prepare('INSERT INTO events (seq, record) VALUES (1, ?)').run(JSON.stringify(record(event, 1)))
    process.stdout.write('RESULT {}\n')
    return
  }
  const provider = openDefault(db, fixture, point)
  const context = suite.callContext()
  const handle =
    step === 'submit'
      ? await provider.command(suite.renameRequest(TASK, 1, REQUEST, 0), context)
      : await provider.commandStatus(REQUEST, context)
  const page = await provider.snapshot(suite.listQuery(SESSION, 10), context)
  const title = page.ok ? (page.value.items[0]?.data as { title?: string } | undefined)?.title : null
  const events = (db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count
  process.stdout.write(`RESULT ${JSON.stringify({ handle, title, events, prepared: fixture.prepared() })}\n`)
  db.close()
}

type Result = {
  handle: { ok: boolean; value: Wire.CommandHandle }
  title: string
  events: number
  prepared: number
}

const self = fileURLToPath(import.meta.url)
const root = fileURLToPath(new URL('../../../..', import.meta.url))

/** Runs one child step; settles once its pipes have closed, so no handle of it outlives the call. */
function run(
  step: string,
  database: string,
  point = 'none',
): Promise<{ signal: NodeJS.Signals | null; pid: number | null; result: Result | null }> {
  return new Promise((resolve, reject) => {
    const proc: ChildProcess = spawn(process.execPath, ['--import', 'tsx', self, step, database, point], {
      cwd: root,
      env: { ...process.env, [CHILD]: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`recovery child timed out\n${stderr}`))
    }, 30_000)
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (/^(INSIDE|COMMITTED)$/m.test(stdout)) proc.kill('SIGKILL')
    })
    proc.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    proc.on('error', reject)
    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      const line = stdout.split('\n').find((text) => text.startsWith('RESULT '))
      if (code !== 0 && signal === null) reject(new Error(`recovery child failed\n${stderr}`))
      else
        resolve({
          signal,
          pid: proc.pid ?? null,
          result: line ? (JSON.parse(line.slice('RESULT '.length)) as Result) : null,
        })
    })
  })
}

if (process.env[CHILD]) {
  const [step = '', database = '', point = 'none'] = process.argv.slice(2)
  await child(step, database, point)
} else {
  const database = () => join(mkdtempSync(join(tmpdir(), 'domain-command-recovery-')), 'domain.sqlite')
  const clean = (path: string) => rmSync(join(path, '..'), { recursive: true, force: true })

  describe('domain command recovery across a killed process', () => {
    it('rolls the whole commit back when killed inside the transaction', async () => {
      const path = database()
      try {
        await run('seed', path)
        expect((await run('submit', path, 'inside')).signal).toBe('SIGKILL')
        const after = (await run('status', path)).result
        expect(after?.handle.value.status).toBe('not-accepted')
        expect([after?.title, after?.events]).toEqual(['Before', 1])
        const retried = (await run('submit', path)).result
        expect(retried?.handle.value.status).toBe('succeeded')
        expect([retried?.events, retried?.prepared]).toEqual([2, 1])
      } finally {
        clean(path)
      }
    }, 120_000)

    it('reads the committed handle without a second prepare when the reply was lost', async () => {
      const path = database()
      try {
        await run('seed', path)
        expect((await run('submit', path, 'after')).signal).toBe('SIGKILL')
        const status = (await run('status', path)).result
        expect(status?.handle.value).toMatchObject({ status: 'succeeded', requestId: REQUEST })
        const retried = (await run('submit', path)).result
        expect(retried?.handle).toEqual(status?.handle)
        expect([retried?.prepared, retried?.events, retried?.title]).toEqual([0, 2, `${TASK} renamed`])
      } finally {
        clean(path)
      }
    }, 120_000)
  })
}
