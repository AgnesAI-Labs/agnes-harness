import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bindAssets } from '../sync/assets.mjs'
import { epochPrefix } from '../sync/config.mjs'
import { createLitestream } from '../sync/litestream.mjs'
import { atomicJson, privateDirectory } from '../sync/private-files.mjs'
import { createStore } from '../sync/s3-store.mjs'
import { restoreState, synchronize } from '../sync/state.mjs'
import { fixture, initialize } from './helpers.mjs'

// The operator supplies short-lived credentials scoped to a NEW synthetic state.
// Never run this against an existing user's state prefix. Remote objects are retained.
test('real COS accepts scoped STS, Litestream dynamic databases and cold restore across epochs', {
  skip: !process.env.AGH_TEST_COS_STS_FILE,
  timeout: 180000,
}, async (t) => {
  const bundle = JSON.parse(await readFile(process.env.AGH_TEST_COS_STS_FILE, 'utf8'))
  const first = bundle.first
  assert.equal(first.epoch, 1)
  assert.equal(first.restore_from_epoch, 0)
  assert.equal(bundle.second.epoch, 2)
  assert.equal(bundle.second.restore_from_epoch, 1)
  assert.equal(bundle.second.prefix, first.prefix)
  const { cfg, root, env } = await fixture(t, {
    AGH_TENANT_ID: 'llmsg',
    AGH_USER_ID: '6',
    AGH_STATE_ID: bundle.state,
    AGH_STATE_EPOCH: '1',
    AGH_STATE_PREFIX: first.prefix,
  })
  const source = { ...cfg, litestream: process.env.AGH_TEST_LITESTREAM }
  await initialize(source)
  await bindAssets(source)
  let current = first
  const store = createStore(first, async () => current)
  const replicator = createLitestream(source)
  t.after(async () => {
    await replicator.close()
    store.close()
  })
  const retry = async (run) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run()
      } catch (error) {
        if (attempt === 5) throw error
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }
  await retry(() => synchronize(source, store, replicator, current))
  const db = new DatabaseSync(join(source.home, 'data', 'tables', 'live-test.db'))
  db.exec(
    "PRAGMA journal_mode=WAL;CREATE TABLE pending_reports(request_id TEXT);INSERT INTO pending_reports VALUES('synthetic-report')",
  )
  db.close()
  current = bundle.renewed
  await atomicJson(source.sts, current)
  await retry(() => synchronize(source, store, replicator, current, undefined, { final: true }))
  const manifest = await store.get(`${epochPrefix(source)}/manifest.json`)
  assert.equal(manifest.stopped, true)
  assert.ok(manifest.databases.some((row) => row.path === 'data/tables/live-test.db'))
  await replicator.close()
  const target = {
    ...source,
    home: join(root, 'restored'),
    run: join(root, 'restore-run'),
    epoch: 2,
    restore: 1,
    initialized: true,
  }
  await privateDirectory(target.home)
  await privateDirectory(target.run)
  current = bundle.second
  const restoreReplicator = createLitestream(target)
  t.after(() => restoreReplicator.close())
  await restoreState(target, store, restoreReplicator, current)
  const restored = new DatabaseSync(join(target.home, 'data', 'tables', 'live-test.db'), { readOnly: true })
  assert.equal(
    restored.prepare('SELECT request_id FROM pending_reports').get().request_id,
    'synthetic-report',
  )
  restored.close()
  await retry(() => synchronize(target, store, restoreReplicator, current, undefined, { final: true }))
  await assert.rejects(store.put(`${epochPrefix(source)}/must-not-write.json`, { synthetic: true }))
  assert.deepEqual(await store.get(`${epochPrefix(source)}/manifest.json`), manifest)
  current = bundle.secondRenewed
  await retry(() => synchronize(target, store, restoreReplicator, current, undefined, { final: true }))
  assert.equal((await store.get(`${epochPrefix(target)}/manifest.json`)).stopped, true)
  await restoreReplicator.close()

  // Execute the real manager and stop client against COS after a same-epoch restart.
  // Only Harness is a fixture; renewal deliberately omits historical read access.
  const runtime = join(root, 'runtime-fixture')
  await privateDirectory(runtime)
  await writeFile(
    join(runtime, 'agnes.mjs'),
    `
    import {createServer} from 'node:http';
    if(process.argv[2]==='serve') createServer((_req,res)=>{
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({token:'fixture-token',expiresAt:Date.now()+60000}));
    }).listen(8443,'127.0.0.1');
  `,
  )
  await atomicJson(join(target.run, 'cos-sts.json'), current)
  const managerEnv = {
    ...process.env,
    ...env,
    AGH_HOME: target.home,
    AGH_SYNC_DIR: target.run,
    AGH_STATE_EPOCH: '2',
    AGH_STATE_INITIALIZED: 'true',
    AGH_RESTORE_FROM_EPOCH: '1',
    AGH_RUNTIME_DIR: runtime,
    AGH_LITESTREAM_BIN: source.litestream,
    AGH_CLOUD_KEY: 'synthetic-cloud-key',
  }
  const manager = spawn(process.execPath, [fileURLToPath(new URL('../sync/main.mjs', import.meta.url))], {
    env: managerEnv,
    stdio: 'ignore',
  })
  t.after(async () => {
    if (manager.exitCode !== null || manager.signalCode !== null) return
    const exited = once(manager, 'exit')
    manager.kill('SIGTERM')
    const timer = setTimeout(() => manager.kill('SIGKILL'), 35000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  })
  const deadline = Date.now() + 30000
  while (true) {
    assert.equal(manager.exitCode, null, 'manager rejected the renewed credential')
    let health
    try {
      health = JSON.parse(await readFile(join(target.run, 'health.json'), 'utf8'))
    } catch {}
    if (health?.backup_status === 'healthy') break
    assert.ok(Date.now() < deadline, `manager not ready: ${health?.last_error}`)
    await new Promise((r) => setTimeout(r, 200))
  }
  await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../sync/cli.mjs', import.meta.url)), 'stop'],
    { env: managerEnv, timeout: 32000 },
  )
  assert.equal(JSON.parse(await readFile(join(target.home, '.cloud-state.json'), 'utf8')).stopped, true)
})
