import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { restoreAssets, snapshotAssets } from './assets.mjs'
import { epochPrefix, identity } from './config.mjs'
import { checkDatabase, databasePath, databases } from './inventory.mjs'
import { atomicJson, fault, noLinks, privateJson } from './private-files.mjs'

const checksum = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const localFile = (config) => join(config.home, '.cloud-state.json')
const restoreFile = (config) => join(config.home, '.cloud-restore.json')
async function fileHash(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export async function localState(config) {
  const value = await privateJson(localFile(config))
  if (value && (checksum(value.identity) !== checksum(identity(config)) || value.epoch !== config.epoch))
    throw fault('SYNC_LOCAL_IDENTITY_MISMATCH')
  if (value) {
    try {
      if (typeof value.stopped !== 'boolean' || !(await privateJson(join(config.home, 'home-layout.json'))))
        throw fault('SYNC_LOCAL_STATE_INVALID')
      checkDatabase(join(config.home, 'data', 'sessions.db'))
    } catch {
      throw fault('SYNC_LOCAL_STATE_INVALID')
    }
  }
  return value
}
export async function ownHome(config, stopped = false) {
  await atomicJson(localFile(config), { identity: identity(config), epoch: config.epoch, stopped })
}
export async function restoreState(config, store, replicator, credential, signal) {
  const local = await localState(config)
  if (local) return local
  const pending = await privateJson(restoreFile(config))
  const entries = await import('node:fs/promises').then((fs) => fs.readdir(config.home))
  if (!pending && entries.some((name) => name !== 'cloud-key')) throw fault('SYNC_LOCAL_STATE_UNRECOGNIZED')
  if (!config.initialized) {
    if (pending) throw fault('SYNC_LOCAL_STATE_UNRECOGNIZED')
    if (await store.get(`${epochPrefix(config)}/manifest.json`, signal))
      throw fault('SYNC_UNEXPECTED_HISTORY')
    return null
  }
  const manifest = await store.get(`${epochPrefix(config, config.restore)}/manifest.json`, signal)
  if (
    manifest?.version !== 1 ||
    manifest.complete !== true ||
    manifest.epoch !== config.restore ||
    checksum(manifest.identity) !== checksum(identity(config))
  )
    throw fault('SYNC_RESTORE_MANIFEST_INVALID')
  const { checksum: expected, ...body } = manifest
  if (
    checksum(body) !== expected ||
    !Array.isArray(manifest.databases) ||
    !manifest.databases.length ||
    manifest.databases.length > 10000
  )
    throw fault('SYNC_RESTORE_MANIFEST_INVALID')
  const seen = new Set()
  for (const row of manifest.databases) {
    const path = databasePath(row.path)
    if (
      seen.has(path) ||
      !Number.isSafeInteger(row.txid) ||
      row.txid < 1 ||
      !Number.isSafeInteger(row.user_version)
    )
      throw fault('SYNC_RESTORE_MANIFEST_INVALID')
    seen.add(path)
  }
  if (!seen.has('data/sessions.db')) throw fault('SYNC_RESTORE_MAIN_MISSING')
  const recovery = {
    identity: identity(config),
    epoch: config.epoch,
    source: config.restore,
    manifest: expected,
  }
  if (pending && checksum(pending) !== checksum(recovery)) throw fault('SYNC_RESTORE_IDENTITY_MISMATCH')
  // Only this private, manifest-bound transaction may resume into a nonempty local home.
  // Neither a provider Key nor an unrelated pre-existing home is taken over or overwritten.
  if (!pending) await atomicJson(restoreFile(config), recovery)
  await restoreAssets(config, manifest.files, signal, { resume: Boolean(pending) })
  for (const row of manifest.databases) {
    signal?.throwIfAborted()
    const path = databasePath(row.path)
    const target = join(config.home, path),
      // A killed restore may leave its temporary file behind. A fresh private name permits
      // retry without deleting it, and the ordinary-file snapshot already excludes .tmp.
      temporary = `${target}.${randomUUID()}.tmp`
    await noLinks(config.home, target)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const existing = await lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existing && (!pending || !existing.isFile() || existing.isSymbolicLink()))
      throw fault('SYNC_RESTORE_TARGET_EXISTS')
    try {
      await replicator.restore(credential, path, config.restore, temporary, signal, row.txid)
      const version = checkDatabase(temporary)
      if (version !== row.user_version) throw fault('SYNC_RESTORE_VERSION_MISMATCH')
      if (existing) {
        // Re-restore the pinned TXID and compare bytes; matching schema versions alone cannot
        // attest that an existing partial database belongs to this recovery transaction.
        if ((await fileHash(target)) !== (await fileHash(temporary)))
          throw fault('SYNC_RESTORE_TARGET_MISMATCH')
      } else await rename(temporary, target)
    } finally {
      // SQLite quick_check may create sidecars even for a read-only temporary database.
      await Promise.all(
        ['', '-wal', '-shm', '-journal'].map((suffix) => rm(`${temporary}${suffix}`, { force: true })),
      )
    }
  }
  await ownHome(config)
  await rm(restoreFile(config))
  return null
}
export async function synchronize(config, store, replicator, credential, signal, { final = false } = {}) {
  const paths = await databases(config, { strict: final })
  if (!paths.includes('data/sessions.db')) throw fault('SYNC_MAIN_DATABASE_NOT_READY')
  if (paths.length > 10000) throw fault('SYNC_DATABASE_LIMIT')
  await replicator.ensure(credential, paths, signal, final)
  const positions = await replicator.sync(paths, signal)
  const files = await snapshotAssets(config, signal)
  const after = await databases(config, { strict: final })
  if (JSON.stringify(paths) !== JSON.stringify(after)) throw fault('SYNC_DATABASE_SET_CHANGED')
  // A published cut must not reference files captured across a changing database cut.
  const confirmed = await replicator.sync(paths, signal)
  if (JSON.stringify(positions) !== JSON.stringify(confirmed))
    throw fault('SYNC_DATABASE_CHANGED_DURING_SNAPSHOT')
  const body = {
    version: 1,
    identity: identity(config),
    epoch: config.epoch,
    complete: true,
    stopped: final,
    created_at: new Date().toISOString(),
    databases: positions.map((row) => ({
      ...row,
      user_version: checkDatabase(join(config.home, row.path), { verify: final }),
    })),
    files,
  }
  signal?.throwIfAborted()
  const manifest = { ...body, checksum: checksum(body) }
  await store.put(`${epochPrefix(config)}/manifest.json`, manifest, signal)
  return manifest.created_at
}
