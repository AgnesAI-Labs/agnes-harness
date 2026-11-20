import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { bindAssets } from '../sync/assets.mjs'
import { epochPrefix } from '../sync/config.mjs'
import { createLitestream } from '../sync/litestream.mjs'
import { privateDirectory } from '../sync/private-files.mjs'
import { restoreState, synchronize } from '../sync/state.mjs'
import { fixture, initialize, memoryStore } from './helpers.mjs'

test('real Litestream backs up dynamic databases, rotates credentials and restores the selected old epoch into a fresh home', async (t) => {
  assert.ok(process.env.AGH_TEST_LITESTREAM, 'Set AGH_TEST_LITESTREAM to the pinned 0.5.18 binary')
  const { cfg, root, credential } = await fixture(t)
  const source = { ...cfg, litestream: process.env.AGH_TEST_LITESTREAM }
  await initialize(source)
  await bindAssets(source)
  await privateDirectory(join(source.home, 'data', 'artifacts'))
  const index = new DatabaseSync(join(source.home, 'data', 'artifacts', 'computer-use-ref-index.db'))
  index.exec("PRAGMA journal_mode=WAL;CREATE TABLE refs(value);INSERT INTO refs VALUES('artifact-ref')")
  index.close()
  const replicaOverride = (path, epoch) => ({
    type: 'file',
    path: join(root, 'replicas', String(epoch), path),
  })
  const replicator = createLitestream(source, { replicaOverride }),
    store = memoryStore()
  t.after(() => replicator.close())
  const retry = async (run) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run()
      } catch (error) {
        if (attempt === 5) throw error
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  }
  await retry(() => synchronize(source, store, replicator, credential))
  const extra = join(source.home, 'data', 'tables', 'new-plugin.db')
  const database = new DatabaseSync(extra)
  await new Promise((resolve) => setTimeout(resolve, 150)) // Empty-file discovery must not permanently miss the database.
  database.exec(
    "PRAGMA journal_mode=WAL;CREATE TABLE queue(value);INSERT INTO queue VALUES('pending-report')",
  )
  await privateDirectory(join(source.home, 'data', 'tables', 'nested'))
  const nested = new DatabaseSync(join(source.home, 'data', 'tables', 'nested', 'resource.db'))
  nested.exec('PRAGMA journal_mode=WAL;CREATE TABLE resources(value)')
  nested.close()
  await retry(() => synchronize(source, store, replicator, credential))
  const rotated = { ...credential, tmp_secret_key: 'rotated-fixture-secret' }
  await retry(() => synchronize(source, store, replicator, rotated))
  database.close()
  await synchronize(source, store, replicator, rotated, undefined, { final: true })
  const manifest = store.values.get(`${epochPrefix(source)}/manifest.json`)
  assert.equal(manifest.complete, true)
  assert.deepEqual(
    manifest.databases.map((row) => row.path),
    [
      'data/sessions.db',
      'data/tables/new-plugin.db',
      'data/tables/nested/resource.db',
      'data/artifacts/computer-use-ref-index.db',
    ].sort(),
  )
  assert.ok(manifest.databases.every((row) => row.txid > 0))
  assert.ok(manifest.files.every((row) => !row.path.includes('-litestream')))
  await replicator.close()

  const target = {
    ...source,
    home: join(root, 'recovered'),
    run: join(root, 'restore-run'),
    epoch: 3,
    restore: 2,
    initialized: true,
  }
  await privateDirectory(target.home)
  await privateDirectory(target.run)
  const restoreReplicator = createLitestream(target, { replicaOverride })
  t.after(() => restoreReplicator.close())
  const next = { ...rotated, epoch: 3, restore_from_epoch: 2 }
  await writeFile(join(target.home, 'cloud-key'), 'fixture-current-provider-key', { mode: 0o600 })
  let restored = 0
  await assert.rejects(
    restoreState(
      target,
      store,
      {
        restore: async (...args) => {
          if (++restored === 2) throw new Error('fixture interrupted restore')
          return restoreReplicator.restore(...args)
        },
      },
      next,
    ),
    /fixture interrupted restore/,
  )
  // The same transaction may resume, but cannot take over different local bytes or an epoch.
  const layoutPath = join(target.home, 'home-layout.json')
  const layout = await readFile(layoutPath)
  await writeFile(layoutPath, Buffer.concat([layout, Buffer.from('\n')]))
  await assert.rejects(restoreState(target, store, restoreReplicator, next), {
    code: 'SYNC_RESTORE_TARGET_MISMATCH',
  })
  assert.deepEqual(await readFile(layoutPath), Buffer.concat([layout, Buffer.from('\n')]))
  await writeFile(layoutPath, layout)
  await assert.rejects(restoreState({ ...target, epoch: 4 }, store, restoreReplicator, next), {
    code: 'SYNC_RESTORE_IDENTITY_MISMATCH',
  })
  const partialPath = join(target.home, manifest.databases[0].path)
  const partial = await readFile(partialPath)
  await writeFile(partialPath, Buffer.concat([partial, Buffer.from('changed')]))
  await assert.rejects(restoreState(target, store, restoreReplicator, next), {
    code: 'SYNC_RESTORE_TARGET_MISMATCH',
  })
  assert.deepEqual(await readFile(partialPath), Buffer.concat([partial, Buffer.from('changed')]))
  await writeFile(partialPath, partial)
  await restoreState(target, store, restoreReplicator, next)
  assert.equal(await readFile(join(target.home, 'cloud-key'), 'utf8'), 'fixture-current-provider-key')
  assert.deepEqual(
    (await readdir(join(target.home, 'data', 'artifacts'))).filter((name) => name.includes('.tmp')),
    [],
  )
  const recovered = new DatabaseSync(join(target.home, 'data', 'tables', 'new-plugin.db'), { readOnly: true })
  assert.deepEqual(
    recovered
      .prepare('SELECT value FROM queue')
      .all()
      .map((row) => row.value),
    ['pending-report'],
  )
  recovered.close()
  const recoveredIndex = new DatabaseSync(
    join(target.home, 'data', 'artifacts', 'computer-use-ref-index.db'),
    { readOnly: true },
  )
  assert.equal(recoveredIndex.prepare('SELECT value FROM refs').get().value, 'artifact-ref')
  recoveredIndex.close()
  await synchronize(target, store, restoreReplicator, next, undefined, { final: true })
  assert.equal(store.values.get(`${epochPrefix(target)}/manifest.json`).epoch, 3)
  // A restore source is never republished or overwritten by the new instance.
  assert.deepEqual(store.values.get(`${epochPrefix(source)}/manifest.json`), manifest)
})
