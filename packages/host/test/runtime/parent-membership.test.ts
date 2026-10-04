import { expect, it } from 'vitest'
import { canonicalJson } from '../../src/runtime/state/canonical-json.js'
import { createParentMembershipReader } from '../../src/runtime/state/parent-membership.js'
import { bodyDigest } from '../../src/runtime/state/records.js'
import { interactionStateFixture } from '../runtime-state-interaction-read-fixture.js'

it('reads real State records without treating a root with no children as completed accounting', async () => {
  const f = await interactionStateFixture(),
    db = f.owner.db
  const before = f.count(),
    reader = createParentMembershipReader(db),
    proof = reader.readChildren(f.actionId)
  expect(proof.parent.actionId).toBe(f.actionId)
  expect(proof.run.runId).toBe('run')
  expect(proof.children).toEqual([])
  expect(() => proof.finalCheck()).not.toThrow()
  expect(() => reader.readUsageReferences(f.actionId, [])).toThrow('membership')
  expect(() => reader.readUsageReferences(f.actionId, ['foreign-usage'])).toThrow('membership')
  expect(() => reader.readUsageReferences(f.actionId, ['same', 'same'])).toThrow('membership')
  expect(() => reader.readChildren('foreign-parent')).toThrow('membership')
  expect(f.count()).toEqual(before)
})
it('refuses tampered original State ledger integrity and its captured final gate without new writes', async () => {
  const f = await interactionStateFixture(),
    db = f.owner.db,
    reader = createParentMembershipReader(db)
  const proof = reader.readChildren(f.actionId),
    before = f.count()
  const row = db
    .prepare('SELECT last_commit_id FROM runtime_records WHERE record_id=?')
    .get(`action:${f.actionId}`)
  if (typeof row?.last_commit_id !== 'string') throw Error('Real original Action commit absent')
  const result = db
    .prepare(
      "UPDATE events SET integrity_digest=? WHERE type='runtime/state-commit' AND json_extract(data,'$.commitId')=?",
    )
    .run('0'.repeat(64), row.last_commit_id)
  expect(result.changes).toBe(1)
  expect(() => proof.finalCheck()).toThrow('membership')
  expect(() => reader.readChildren(f.actionId)).toThrow('membership')
  expect(f.count()).toEqual(before)
})
it('refuses rewritten native Run projection with the original immutable manifest unchanged', async () => {
  const f = await interactionStateFixture(),
    db = f.owner.db,
    reader = createParentMembershipReader(db)
  expect(reader.readChildren(f.actionId).run.runId).toBe('run')
  const row = db.prepare('SELECT * FROM runtime_records WHERE record_id=?').get('run:run')
  if (
    typeof row?.value_json !== 'string' ||
    typeof row.owner_json !== 'string' ||
    typeof row.last_commit_id !== 'string' ||
    typeof row.record_revision !== 'number' ||
    !Number.isSafeInteger(row.record_revision) ||
    row.record_revision < 1
  )
    throw Error('Real original Run absent')
  const owner = JSON.parse(row.owner_json),
    value = JSON.parse(row.value_json)
  value.deadline = '2100-01-01T00:00:00.000Z'
  const digest = bodyDigest(owner, value),
    before = f.count()
  const native = db
    .prepare('SELECT versions_json FROM runtime_commit_proofs WHERE commit_id=?')
    .get(row.last_commit_id)
  if (typeof native?.versions_json !== 'string') throw Error('Real original native proof absent')
  const versions = JSON.parse(native.versions_json)
  for (const version of versions)
    if (version.recordId === 'run:run' && version.recordRevision === row.record_revision)
      version.digest = digest
  db.prepare('UPDATE runtime_version_bodies SET value_json=? WHERE record_id=? AND record_revision=?').run(
    canonicalJson(value),
    'run:run',
    row.record_revision,
  )
  db.prepare('UPDATE runtime_record_heads SET body_digest=? WHERE record_id=?').run(digest, 'run:run')
  db.prepare('UPDATE runtime_commit_proofs SET versions_json=? WHERE commit_id=?').run(
    canonicalJson(versions),
    row.last_commit_id,
  )
  expect(() => reader.readChildren(f.actionId)).toThrow('membership')
  expect(f.count()).toEqual(before)
})
