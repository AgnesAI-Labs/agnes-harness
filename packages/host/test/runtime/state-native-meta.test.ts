import { rmSync } from 'node:fs'
import type { SnapshotRef } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../../src/runtime/state/canonical-json.js'
import { RUN_RECORD_SCHEMA } from '../../src/runtime/state/records.js'
import {
  assertNativeSessionHasNoParent,
  captureNativeStateReadPort,
  rebuildNativeVisible,
} from '../../src/runtime/state/transactions.js'
import { originalNativeFixture } from './fixtures/native-state-read-fixture.js'
import { commitPreparedActions, FIXTURE_SESSION } from './fixtures/state-query-fixture.js'

type Native = Awaited<ReturnType<typeof originalNativeFixture>>

// Event times keep the spelling they were written with, so compare instants, not strings.
const instant = (text: string) => Date.parse(text)
async function page(native: Native, snapshot: SnapshotRef) {
  return native.reader.scanVerifiedPage(
    snapshot,
    { snapshot, collection: 'records', filter: {}, order: 'asc', cursor: null, limit: 500 },
    native.context,
  )
}
async function withNative(
  body: (native: Native, clock: { now: number }) => Promise<void>,
  startAt?: (fixtureNow: number) => number,
) {
  const clock = { now: 0 }
  // The fixture's own start time is only known once its input exists; start at that instant.
  const { admissionFixtureInput } = await import(
    '../../../extension-api/testkit/runtime/contracts/assembly-admission.js'
  )
  const base = Date.parse(admissionFixtureInput().fixture.now)
  clock.now = startAt ? startAt(base) : base
  const native = await originalNativeFixture({ clock: () => clock.now })
  try {
    await native.fixture.coordinator.coordinate(native.fixture.draft(), native.fixture.context())
    await body(native, clock)
  } finally {
    native.reader.close()
    native.identity.close()
    await native.fixture.close()
    rmSync(native.directory, { recursive: true, force: true })
  }
}
const refusal = (detailCode: string) =>
  expect.objectContaining({ failure: expect.objectContaining({ detailCode }) })

describe.skipIf(typeof process.getuid !== 'function')('historical meta of native facts', () => {
  it('takes createdAt, updatedAt and lastCommitId from the original commit events, not from the head or the clock', async () => {
    await withNative(async (native, clock) => {
      const { context, reader, fixture } = native
      const created = clock.now
      clock.now = created + 2_000
      const position = await commitPreparedActions(native, 3)
      const old = await reader.openVerifiedSnapshot(FIXTURE_SESSION, context)
      const before = await page(native, old)
      clock.now = created + 6_000
      await commitPreparedActions(native, 5, position)
      const run = before.items.find((item) => item.schema.typeId === 'agh.runtime/run-record@1')
      expect(instant(run.createdAt)).toBe(created)
      expect(instant(run.updatedAt)).toBe(created + 2_000)
      const ts = fixture.db
        .prepare(
          `SELECT e.ts FROM runtime_commit_proofs p JOIN events e ON e.session_key=? AND e.seq=p.ledger_seq WHERE p.commit_id=?`,
        )
        .get(FIXTURE_SESSION, run.commitId)?.ts
      expect(run.updatedAt).toBe(ts)
      expect(run.minReader).toBe(2)
      expect(await page(native, old)).toEqual(before)
      // min_reader is not tampered here: State's own head verification already rejects a wrong value.
      fixture.db
        .prepare(`UPDATE runtime_record_heads SET created_at=?, updated_at=? WHERE record_id=?`)
        .run('1999-01-01T00:00:00Z', '1999-01-01T00:00:00Z', run.recordId)
      expect(await page(native, old)).toEqual(before)
      const later = await reader.openVerifiedSnapshot(FIXTURE_SESSION, context)
      const newest = (await page(native, later)).items.find((item) => item.recordId === run.recordId)
      expect(newest.createdAt).toBe(run.createdAt)
      expect(instant(newest.updatedAt)).toBe(created + 6_000)
      expect(newest.recordRevision).toBeGreaterThan(run.recordRevision)
    })
  }, 120_000)

  it('refuses to read once a commit event time is damaged', async () => {
    await withNative(async (native) => {
      const { context, reader, fixture } = native
      const snapshot = await reader.openVerifiedSnapshot(FIXTURE_SESSION, context)
      fixture.db
        .prepare(`UPDATE events SET ts='yesterday' WHERE session_key=? AND type='runtime/state-commit'`)
        .run(FIXTURE_SESSION)
      await expect(page(native, snapshot)).rejects.toThrow(refusal('integrity'))
    })
  }, 60_000)

  it('refuses the whole page when a readable record is stored under a revision the table does not list', async () => {
    await withNative(async (native) => {
      const { fixture, identity } = native
      const stale = { ...RUN_RECORD_SCHEMA, digest: '0'.repeat(64) }
      const port = captureNativeStateReadPort(fixture.state, identity, fixture.db, [stale])
      if (!port) throw Error('port unavailable')
      const opened = await port.open(FIXTURE_SESSION)
      await expect(port.facts(opened.snapshot)).rejects.toThrow(refusal('state_legacy_version'))
      const current = captureNativeStateReadPort(fixture.state, identity, fixture.db)
      if (!current) throw Error('port unavailable')
      const facts = await current.facts((await current.open(FIXTURE_SESSION)).snapshot)
      expect(facts.some((fact) => fact.recordId.startsWith('run:'))).toBe(true)
    })
  }, 60_000)

  it('rebuilds visible versions from proofs and refuses history it cannot prove', () => {
    const schema = RUN_RECORD_SCHEMA
    const header = (revision: number) => ({
      recordId: 'run:x',
      recordRevision: revision,
      schemaJson: canonicalJson(schema),
      digest: `d${revision}`,
      ownerJson: '{}',
      hasBody: true,
    })
    const proof = (seq: number, ts: string, previous: number | null, revision: number | null) => ({
      commit_id: `c${seq}`,
      ledger_seq: seq,
      event_ts: ts,
      sides_json: '[]',
      versions_json: JSON.stringify(revision === null ? [] : [header(revision)]),
      manifests_json: JSON.stringify([
        {
          recordId: 'run:x',
          previousRevision: previous,
          nextJson:
            revision === null
              ? null
              : JSON.stringify({ recordRevision: revision, digest: `d${revision}`, schema }),
        },
      ]),
    })
    const ok = rebuildNativeVisible([
      proof(1, '2026-10-05T00:00:00Z', null, 1),
      proof(2, '2026-10-05T00:01:00Z', 1, 2),
    ])
    expect(ok.created.get('run:x')).toBe('2026-10-05T00:00:00Z')
    expect(ok.visible.get('run:x')).toMatchObject({ revision: 2, commitId: 'c2', at: '2026-10-05T00:01:00Z' })
    expect(() => rebuildNativeVisible([proof(1, 'yesterday', null, 1)])).toThrow(
      refusal('state_meta_unproven'),
    )
    expect(() =>
      rebuildNativeVisible([
        proof(1, '2026-10-05T00:00:00Z', null, 1),
        proof(2, '2026-10-05T00:01:00Z', null, 1),
      ]),
    ).toThrow(refusal('state_meta_unproven'))
    expect(() => rebuildNativeVisible([proof(1, '2026-10-05T00:00:00Z', 1, 2)])).toThrow(
      refusal('state_meta_unproven'),
    )
  })

  it('refuses a session that has a parent prefix', () => {
    expect(() => assertNativeSessionHasNoParent(null)).not.toThrow()
    expect(() => assertNativeSessionHasNoParent({ sessionId: 'p', throughSeq: 1 } as never)).toThrow(
      refusal('state_session_parent'),
    )
  })
})
