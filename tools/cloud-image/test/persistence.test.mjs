import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { bindAssets, restoreAssets, snapshotAssets } from '../sync/assets.mjs'
import { configuration, credentials, epochPrefix, publicEnvironment } from '../sync/config.mjs'
import { coordinator } from '../sync/coordinator.mjs'
import { atomicJson, privateDirectory } from '../sync/private-files.mjs'
import { cloudKey } from '../sync/runtime.mjs'
import { localState, ownHome, restoreState, synchronize } from '../sync/state.mjs'

import { fakeReplicator, fixture, initialize, memoryStore } from './helpers.mjs'

test('requires stable state inputs, exact credential binding and private fresh STS; never substitutes a Key', async (t) => {
  const { cfg, env, credential } = await fixture(t)
  const compact = '11111111111141118111111111111111'
  assert.equal(
    configuration({ ...env, AGH_STATE_ID: compact, AGH_STATE_PREFIX: `agh-state/fixture/1001/${compact}` })
      .state,
    compact,
  )
  assert.equal((await credentials(cfg)).tmp_secret_id, 'fixture-id')
  for (const changes of [
    { AGH_STATE_ID: '' },
    { AGH_STATE_PREFIX: '../escape' },
    { AGH_STATE_EPOCH: '2oops' },
    { AGH_STATE_INITIALIZED: 'true', AGH_RESTORE_FROM_EPOCH: '' },
    { AGH_STATE_INITIALIZED: 'true', AGH_RESTORE_FROM_EPOCH: '2' },
    { AGH_ASSETS_DIR: cfg.home },
  ])
    assert.throws(() => configuration({ ...env, ...changes }), /SYNC_/)
  for (const changes of [
    { epoch: 1 },
    { session_token: undefined },
    { expired_time: undefined },
    { session_token: undefined, expired_time: undefined },
    { prefix: 'other' },
    { restore_from_epoch: 9 },
    { expired_time: 1 },
    { endpoint: 'http://cos.fixture' },
    { session_token: 'invalid\nheader' },
  ]) {
    await atomicJson(cfg.sts, { ...credential, ...changes })
    await assert.rejects(credentials(cfg), /SYNC_/)
  }
  await atomicJson(cfg.sts, credential)
  await chmod(cfg.sts, 0o644)
  await assert.rejects(credentials(cfg), /SYNC_/)
  await rm(cfg.sts)
  await symlink(join(cfg.home, 'elsewhere'), cfg.sts)
  await assert.rejects(credentials(cfg), /SYNC_/)
  assert.deepEqual(
    publicEnvironment({
      PATH: 'fixture',
      AWS_SESSION_TOKEN: 'secret',
      LITESTREAM_ACCESS_KEY_ID: 'secret',
      COS_SECRET: 'secret',
      AGH_COS_STS_SECRET_KEY: 'secret',
      AGH_COS_STS_SECRET_ID: 'secret',
    }),
    { PATH: 'fixture' },
  )
  const restored = { ...cfg, restore: 1, initialized: true }
  await rm(cfg.sts)
  await atomicJson(cfg.sts, { ...credential, restore_from_epoch: 0 })
  await assert.rejects(credentials(restored), /SYNC_STS_INVALID/)
  assert.equal((await credentials(restored, Date.now(), { restoreCompleted: true })).restore_from_epoch, 0)
})
test('mirrors only ordinary approved files into CFS, verifies restore and refuses symlinks or hidden databases', async (t) => {
  const { cfg } = await fixture(t)
  await initialize(cfg)
  await bindAssets(cfg)
  await privateDirectory(join(cfg.home, 'data', 'artifacts', 'sha256'))
  await writeFile(join(cfg.home, 'data', 'artifacts', 'sha256', 'image'), 'image-bytes')
  await writeFile(join(cfg.home, 'cloud-key'), 'never-back-up-key', { mode: 0o600 })
  await writeFile(join(cfg.home, 'profiles', 'local-dev', 'configuration-lock.sqlite'), 'lock')
  const files = await snapshotAssets(cfg)
  assert.ok(files.some((f) => f.path.endsWith('/image')))
  assert.ok(
    files.every(
      (f) => !f.path.endsWith('.db') && !f.path.endsWith('.sqlite') && !f.path.endsWith('cloud-key'),
    ),
  )
  const other = { ...cfg, home: join(cfg.home, 'recovered') }
  await mkdir(other.home)
  await restoreAssets(other, files)
  assert.equal(
    await readFile(join(other.home, 'data', 'artifacts', 'sha256', 'image'), 'utf8'),
    'image-bytes',
  )
  await symlink('/etc/passwd', join(cfg.home, 'profiles', 'local-dev', 'bad'))
  await assert.rejects(snapshotAssets(cfg), /SYNC_/)
  await rm(join(cfg.home, 'profiles', 'local-dev', 'bad'))
  await writeFile(join(cfg.home, 'profiles', 'local-dev', 'disguised.json'), Buffer.from('SQLite format 3\0'))
  await assert.rejects(snapshotAssets(cfg), /SYNC_UNEXPECTED_SQLITE_ASSET/)
  await assert.rejects(
    restoreAssets(other, [{ path: '../escape', sha256: 'a'.repeat(64), size: 0 }]),
    /SYNC_/,
  )
})
test('never initializes missing historical backups or restores a mismatched state', async (t) => {
  const { cfg, credential } = await fixture(t, { AGH_STATE_INITIALIZED: 'true', AGH_RESTORE_FROM_EPOCH: '1' })
  await bindAssets(cfg)
  const store = memoryStore()
  await assert.rejects(
    restoreState(cfg, store, fakeReplicator(), credential),
    /SYNC_RESTORE_MANIFEST_INVALID/,
  )
  store.values.set(`${epochPrefix(cfg, 1)}/manifest.json`, {
    version: 1,
    complete: true,
    epoch: 1,
    identity: { state: 'other' },
  })
  await assert.rejects(
    restoreState(cfg, store, fakeReplicator(), credential),
    /SYNC_RESTORE_MANIFEST_INVALID/,
  )
  assert.deepEqual(await import('node:fs/promises').then((fs) => fs.readdir(cfg.home)), [])
  await ownHome(cfg)
  await assert.rejects(localState(cfg), /SYNC_LOCAL_STATE_INVALID/)
})
test('publishes a recoverable new database set and never publishes completion when final sync fails', async (t) => {
  const { cfg, credential } = await fixture(t)
  await initialize(cfg)
  await bindAssets(cfg)
  const store = memoryStore(),
    replicator = fakeReplicator()
  await synchronize(cfg, store, replicator, credential)
  const extra = new DatabaseSync(join(cfg.home, 'data', 'tables', 'new-plugin.db'))
  extra.exec('CREATE TABLE q(x)')
  extra.close()
  await synchronize(cfg, store, replicator, credential, undefined, { final: true })
  const key = `${epochPrefix(cfg)}/manifest.json`,
    success = store.values.get(key)
  assert.equal(success.stopped, true)
  assert.deepEqual(
    success.databases.map((row) => row.path),
    ['data/sessions.db', 'data/tables/new-plugin.db'],
  )
  let changed = false
  replicator.sync = async (paths) => {
    changed = !changed
    return paths.map((path) => ({ path, txid: changed ? 2 : 3 }))
  }
  await assert.rejects(
    synchronize(cfg, store, replicator, credential),
    /SYNC_DATABASE_CHANGED_DURING_SNAPSHOT/,
  )
  assert.deepEqual(store.values.get(key), success)
  replicator.sync = async () => {
    throw Error('synthetic failure')
  }
  await assert.rejects(synchronize(cfg, store, replicator, credential, undefined, { final: true }))
  assert.deepEqual(store.values.get(key), success)
})
test('coordinator preserves reports and a stopped instance on final backup failure, then retries with a rotated STS', async (t) => {
  const { cfg, credential } = await fixture(t)
  const store = memoryStore(),
    replicator = fakeReplicator()
  let writeCredential = credential,
    stopCount = 0
  const runtime = {
    boot: () => initialize(cfg),
    ready: async () => true,
    stop: async () => {
      stopCount++
    },
  }
  const manager = coordinator(cfg, {
    store,
    replicator,
    runtime,
    tickMs: 60000,
    readCredentials: async () => writeCredential,
  })
  t.after(() => manager.close())
  await manager.init()
  assert.equal((await manager.health()).backup_status, 'healthy')
  replicator.sync = async () => {
    throw Error('cannot upload')
  }
  assert.equal((await manager.stop()).ok, false)
  assert.equal((await manager.health()).backup_status, 'failed')
  assert.equal(JSON.parse(await readFile(join(cfg.home, '.cloud-state.json'))).stopped, true)
  replicator.sync = async (_paths, signal) =>
    new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(Error('deadline'))
        return
      }
      signal.addEventListener('abort', () => reject(Error('deadline')), { once: true })
    })
  assert.equal((await manager.stop({ timeoutMs: 20 })).ok, false)
  assert.equal(store.values.get(`${epochPrefix(cfg)}/manifest.json`).stopped, false)
  writeCredential = { ...credential, tmp_secret_key: 'rotated-fixture-secret' }
  replicator.sync = async (paths) => paths.map((path) => ({ path, txid: 2 }))
  assert.equal((await manager.stop()).ok, true)
  assert.equal(stopCount, 1)
  assert.equal(store.values.get(`${epochPrefix(cfg)}/manifest.json`).stopped, true)
  assert.ok(!JSON.stringify(await manager.health()).includes('fixture-secret'))
})
test('reads current cloud-key file for health authentication without accepting stale fallback on invalid files', async (t) => {
  const { cfg } = await fixture(t),
    env = { AGH_CLOUD_KEY: 'fixture-env-key' }
  assert.equal(await cloudKey(cfg, env), 'fixture-env-key')
  await assert.rejects(cloudKey(cfg, { ...env, AGH_API_KEY: 'conflicting-key' }), /SYNC_CLOUD_KEY_INVALID/)
  const file = join(cfg.home, 'cloud-key')
  await writeFile(file, 'fixture-file-key\n', { mode: 0o600 })
  assert.equal(await cloudKey(cfg, env), 'fixture-file-key')
  await writeFile(`${file}.next`, 'rotated-file-key', { mode: 0o600 })
  await rename(`${file}.next`, file)
  assert.equal(await cloudKey(cfg, env), 'rotated-file-key')
  await writeFile(file, '')
  await assert.rejects(cloudKey(cfg, env), /SYNC_CLOUD_KEY_INVALID/)
})

test('restored startup confirms its new epoch before background retries resume writing', async (t) => {
  const { cfg, credential } = await fixture(t, { AGH_STATE_INITIALIZED: 'true', AGH_RESTORE_FROM_EPOCH: '1' })
  await initialize(cfg)
  await ownHome(cfg)
  const store = memoryStore(),
    replicator = fakeReplicator()
  let writing = false,
    txid = 2
  replicator.sync = async (paths) => paths.map((path) => ({ path, txid: writing ? txid++ : 1 }))
  const manager = coordinator(cfg, {
    store,
    replicator,
    tickMs: 10,
    readCredentials: async () => credential,
    runtime: {
      boot: async () => {
        writing = true
      },
      ready: async () => true,
    },
  })
  try {
    await manager.init()
    const initial = await manager.health()
    assert.equal(initial.backup_status, 'healthy')
    assert.ok(initial.last_sync_at)
    assert.ok(store.values.get(`${epochPrefix(cfg)}/manifest.json`).databases.every((row) => row.txid === 1))
    const deadline = Date.now() + 1000
    while ((await manager.health()).backup_status !== 'degraded') {
      assert.ok(Date.now() < deadline, 'ongoing unconfirmed changes must still report degraded')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal((await manager.health()).last_sync_at, initial.last_sync_at)
  } finally {
    await manager.close()
  }
})
