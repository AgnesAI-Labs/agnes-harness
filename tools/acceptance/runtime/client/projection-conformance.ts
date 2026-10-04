import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { killWhenReady } from '../../../../examples/runtime-reference/src/providers/interaction-contract.js'
import { bindProjectionContract } from '../../../../examples/runtime-reference/src/providers/projection-contract.js'
import { type DomainCommandStorage, fail } from '../../../../packages/core/src/runtime/projection/commands.js'
import { createProjectionProvider } from '../../../../packages/core/src/runtime/providers/projection.js'
import {
  crashProjection,
  createProjectionFixture,
  type ProjectionCrash,
  type ProjectionFixture,
  type ProjectionSubject,
  projectionContractPort,
  registerProjectionContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/projection.js'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.js'
import type * as Wire from '../../../../packages/protocol/src/runtime/index.js'
import { canonicalJsonDigest } from '../../../../packages/protocol/src/runtime/index.js'
import {
  getConformanceBuildIdentity,
  withConformanceBuild,
  withDeploymentStandIns,
} from '../build-identity.js'

const CONTRACT = 'agh.projection'
const PROVIDERS = ['default', 'reference'] as const
const RECIPE = 'packages/core/src/runtime/providers/projection.ts'
const STAND_INS =
  "command store and journal are a test SQLite database, and access and native history are the suite's; not evidence for the Host storage composition"
// Its own logical name, so the run's one test service container holds it beside the reference store.
const LOGICAL_NAME = 'tasks-default'
const BINDING = {
  bindingId: 'default-projection',
  contract: CONTRACT,
  logicalName: LOGICAL_NAME,
  providerId: 'default',
}
const AUTHORITY = 'default-projection-authority'
const AGGREGATE = { typeId: 'conformance.tasks/board@1', id: 'board' }
const NO_READS = {
  query: async () => fail('unsupported', 'no selector reads in this test'),
  resolveData: async () => fail('unsupported', 'no selector reads in this test'),
}

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const self = fileURLToPath(import.meta.url)
const sha256 = (path: string) =>
  createHash('sha256')
    .update(readFileSync(join(root, path)))
    .digest('hex')

// The Core projection tests' SQLite command store and journal, standing in for the Host storage the
// default provider is not yet composed with.
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

function sqliteStorage(db: DatabaseSync): DomainCommandStorage {
  const row = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as T | undefined
  return {
    async transaction(body) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = body({
          command: (key) => {
            const found = row<{ body: string }>('SELECT body FROM commands WHERE key = ?', key)
            return found ? JSON.parse(found.body) : undefined
          },
          putCommand: (command) =>
            void db
              .prepare('INSERT INTO commands (key, body) VALUES (?, ?)')
              .run(command.key, JSON.stringify(command)),
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
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

const record = (event: Wire.DomainEvent, sequence: number): Wire.DomainEventRecord => ({
  event,
  authorityId: AUTHORITY,
  sequence,
  aggregate: { authorityId: AUTHORITY, ...AGGREGATE, revision: sequence },
  fingerprint: canonicalJsonDigest(event.eventId),
})

/** The default provider over one SQLite connection, as one process opens it. */
function openDefault(db: DatabaseSync, fixture: ProjectionFixture, domain = fixture.domain) {
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
      authorityId: AUTHORITY,
      aggregate: AGGREGATE,
      source: BINDING,
      stateSchema: fixture.domain.commandStateSchema,
      destination: 'runtime-inbox',
      storage: sqliteStorage(db),
      clock: { now: () => '2026-10-01T00:00:00Z', newId: () => randomUUID() },
    },
  })
}

/**
 * The default provider as the shared suite drives it. `db` outlives every provider instance, over a
 * SQLite file that the provider process a crash starts opens too.
 */
function defaultSubject(path: string, db: DatabaseSync, fixture: ProjectionFixture): ProjectionSubject {
  let current = openDefault(db, fixture)
  return {
    binding: {
      requirement: {
        contract: CONTRACT,
        major: 1,
        logicalName: LOGICAL_NAME,
        features: [],
        scope: 'workspace',
        optional: false,
      },
      binding: BINDING,
      query: (request, context) => current.query(request, context),
    },
    fixture,
    service: () => current,
    async append(events) {
      await sqliteStorage(db).transaction((tx) => {
        for (const event of events) tx.putEvent(record(event, tx.lastSequence() + 1))
      })
      await current.refresh()
    },
    async crash(crash) {
      current.close()
      try {
        const killed = await killWhenReady(
          [path, JSON.stringify(crash)],
          (stdout) => stdout.includes('READY\n'),
          self,
        )
        return { signal: killed.signal, pid: killed.pid }
      } finally {
        current = openDefault(db, fixture)
      }
    },
    close: async () => current.close(),
    remains: () => (db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count > 0,
    mountRefused() {
      // Creating the default acquires nothing of its own; it fails at creation only by refusing a reader
      // policy it cannot apply.
      const rules = [{ pointer: '/tasks/*x/title', resourcePointer: '', operation: 'read' }]
      try {
        openDefault(db, fixture, {
          ...fixture.domain,
          readerPolicy: { ...fixture.domain.readerPolicy, rules },
        })
        return false
      } catch {
        return true
      }
    },
    remount() {
      current = openDefault(db, fixture)
      current.close()
    },
  }
}

/** Registers the six projection cases for the Core default provider on a fresh test database. */
function bindDefaultProjectionContract(harness: ConformanceHarness, command: string): void {
  const path = join(mkdtempSync(join(tmpdir(), 'default-projection-contract-')), 'projection.sqlite')
  registerProjectionContract(withDeploymentStandIns(harness, STAND_INS), {
    providerId: 'default',
    recipe: RECIPE,
    command,
    build: getConformanceBuildIdentity(),
    providerDigest: sha256(RECIPE),
    configDigest: canonicalJsonDigest({ retainedRevisions: 64 }),
    releaseSetDigest: sha256('packages/core/package.json'),
    port: projectionContractPort(defaultSubject(path, openStorage(path), createProjectionFixture())),
  })
}

// The Core default provider, over the test database above, and the reference store bind here. The runner
// has no teardown, so the databases live until the process exits.
export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  if (request.contracts !== 'all' && !request.contracts.includes(CONTRACT))
    return { contracts: [], providers: [] }
  const providers = PROVIDERS.filter((providerId) => request.providers.includes(providerId))
  for (const providerId of providers) {
    if (providerId === 'reference')
      bindProjectionContract(withConformanceBuild(harness), request.command, { providerId })
    else bindDefaultProjectionContract(harness, request.command)
  }
  return { contracts: [CONTRACT], providers }
}

// The provider process `recover` starts: `<database> <ProjectionCrash as JSON>`. It is killed at READY.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const [path, crash] = process.argv.slice(2)
  if (path === undefined || crash === undefined) throw new Error('expected: <database> <crash>')
  const fixture = createProjectionFixture()
  crashProjection(
    defaultSubject(path, openStorage(path), fixture),
    JSON.parse(crash) as ProjectionCrash,
    () => {
      writeSync(1, 'READY\n')
      // Blocks this thread, so nothing after the held prepare can run before the kill.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
    },
  ).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'projection child failed'}\n`)
    process.exitCode = 1
  })
}
