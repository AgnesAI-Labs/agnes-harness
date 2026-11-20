import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { configuration } from '../sync/config.mjs'
import { atomicJson, privateDirectory } from '../sync/private-files.mjs'
export async function fixture(t, over = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agh-persistence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = {
    AGH_TENANT_ID: 'fixture',
    AGH_USER_ID: '1001',
    AGH_STATE_ID: '11111111-1111-4111-8111-111111111111',
    AGH_STATE_EPOCH: '2',
    AGH_STATE_INITIALIZED: 'false',
    AGH_RESTORE_FROM_EPOCH: '',
    AGH_STATE_PREFIX: 'agh-state/fixture/1001/11111111-1111-4111-8111-111111111111',
    AGH_HOME: join(root, 'home'),
    AGH_ASSETS_DIR: join(root, 'assets'),
    WORKSPACE_DIR: join(root, 'workspace'),
    AGH_SYNC_DIR: join(root, 'run'),
    ...over,
  }
  const cfg = configuration(env)
  for (const path of [cfg.home, cfg.assets, cfg.workspace, cfg.run]) await privateDirectory(path)
  const credential = {
    tmp_secret_id: 'fixture-id',
    tmp_secret_key: 'fixture-secret',
    session_token: 'fixture-session',
    expired_time: Math.floor(Date.now() / 1000) + 3600,
    bucket: 'fixture-bucket',
    region: 'ap-shanghai',
    endpoint: 'https://cos.ap-shanghai.myqcloud.com',
    prefix: cfg.prefix,
    epoch: cfg.epoch,
    restore_from_epoch: cfg.restore,
  }
  await atomicJson(cfg.sts, credential)
  return { root, env, cfg, credential }
}
export async function initialize(cfg) {
  await atomicJson(join(cfg.home, 'home-layout.json'), {
    version: 1,
    instanceId: '22222222-2222-4222-8222-222222222222',
  })
  await privateDirectory(join(cfg.home, 'data', 'tables'))
  const db = new DatabaseSync(join(cfg.home, 'data', 'sessions.db'))
  db.exec(
    "PRAGMA journal_mode=WAL;PRAGMA user_version=2;CREATE TABLE messages(text);INSERT INTO messages VALUES('fixture')",
  )
  db.close()
  await privateDirectory(join(cfg.home, 'profiles', 'local-dev'))
  await atomicJson(join(cfg.home, 'profiles', 'local-dev', 'configuration.json'), { fixture: true })
}
export function memoryStore() {
  const values = new Map()
  return {
    values,
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    close() {},
  }
}
export function fakeReplicator() {
  return {
    ensure: async () => {},
    sync: async (paths) => paths.map((path) => ({ path, txid: 1 })),
    close: async () => {},
    restore: async () => {
      throw Error('not expected')
    },
  }
}
