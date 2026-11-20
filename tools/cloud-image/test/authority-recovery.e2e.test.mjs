import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { bindAssets } from '../sync/assets.mjs'
import { createLitestream } from '../sync/litestream.mjs'
import { privateDirectory } from '../sync/private-files.mjs'
import { restoreState, synchronize } from '../sync/state.mjs'
import { fixture, initialize, memoryStore } from './helpers.mjs'

function table(database) {
  return {
    exec: (sql, params = []) => database.prepare(sql).run(...params),
    get: (sql, params = []) => database.prepare(sql).get(...params),
    all: (sql, params = []) => database.prepare(sql).all(...params),
    transaction: (fn) => {
      database.exec('BEGIN')
      try {
        const result = fn()
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
}

test('real Litestream preserves the production attachment authority before and after epoch recovery', async (t) => {
  assert.ok(process.env.AGH_TEST_LITESTREAM, 'Set the pinned Litestream binary')
  assert.ok(process.env.AGH_TEST_AUTHORITY_MODULE, 'Build the actual Harness authority module first')
  const { PersistentArtifactReadAuthorityIndex } = await import(
    pathToFileURL(process.env.AGH_TEST_AUTHORITY_MODULE)
  )
  const { cfg, root, credential } = await fixture(t)
  const source = { ...cfg, litestream: process.env.AGH_TEST_LITESTREAM }
  await initialize(source)
  await bindAssets(source)
  const path = 'data/tables/attachment-authority.db'
  const db = new DatabaseSync(join(source.home, path))
  db.exec('PRAGMA journal_mode=WAL')
  t.after(() => db.close())
  const store = memoryStore()
  const replicaOverride = (path, epoch) => ({
    type: 'file',
    path: join(root, 'replicas', String(epoch), path),
  })
  const replicator = createLitestream(source, { replicaOverride })
  t.after(() => replicator.close())
  await replicator.ensure(credential, ['data/sessions.db', path])
  const metadataDeadline = Date.now() + 5000
  while (
    db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('_litestream_seq','_litestream_lock')")
      .get().n !== 2
  ) {
    assert.ok(
      Date.now() < metadataDeadline,
      'real watcher must create replication metadata before business initialization',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  // Directory discovery may win the race with the first business schema initialization.
  const index = new PersistentArtifactReadAuthorityIndex(table(db))
  const artifact = {
    sha256: createHash('sha256').update('attachment').digest('hex'),
    size: 10,
    mime: 'text/plain',
  }
  const binding = { sessionId: 'session', laneId: 'lane', ownerId: 'owner', artifact }
  const writer = { permission: 'append', sessionId: 'session', laneId: 'lane', principalId: 'owner' }
  assert.equal(index.append(writer, binding).ok, true)
  for (let attempt = 0; ; attempt++) {
    try {
      await synchronize(source, store, replicator, credential)
      break
    } catch (error) {
      if (attempt === 5) throw error
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  assert.deepEqual(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('_litestream_seq','_litestream_lock') ORDER BY name",
      )
      .all()
      .map((row) => row.name),
    ['_litestream_lock', '_litestream_seq'],
  )
  assert.deepEqual(index.resolve('session', 'lane', artifact.sha256), binding)
  assert.equal(index.resolve('other-session', 'lane', artifact.sha256), undefined)
  await synchronize(source, store, replicator, credential, undefined, { final: true })
  await replicator.close()
  const target = {
    ...source,
    home: join(root, 'recovered'),
    run: join(root, 'restore-run'),
    initialized: true,
    epoch: 3,
    restore: 2,
  }
  await privateDirectory(target.home)
  await privateDirectory(target.run)
  const restoredReplicator = createLitestream(target, { replicaOverride })
  t.after(() => restoredReplicator.close())
  await restoreState(target, store, restoredReplicator, { ...credential, epoch: 3, restore_from_epoch: 2 })
  const recovered = new DatabaseSync(join(target.home, path))
  t.after(() => recovered.close())
  const reopened = new PersistentArtifactReadAuthorityIndex(table(recovered))
  assert.deepEqual(reopened.resolve('session', 'lane', artifact.sha256), binding)
  assert.equal(reopened.append({ ...writer, principalId: 'other' }, binding).code, 'forbidden')
  recovered.exec(
    'CREATE TRIGGER injected AFTER INSERT ON _litestream_lock BEGIN DELETE FROM artifact_read_authority_v1; END',
  )
  assert.throws(() => reopened.resolve('session', 'lane', artifact.sha256), /index unavailable/)
  assert.equal(recovered.prepare('SELECT count(*) AS n FROM artifact_read_authority_v1').get().n, 1)
})
