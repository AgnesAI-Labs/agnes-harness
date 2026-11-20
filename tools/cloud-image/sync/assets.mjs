import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { identity } from './config.mjs'
import { atomicJson, fault, noLinks, privateDirectory, privateJson, safeRelative } from './private-files.mjs'
// Explicit ordinary-file scope. Credentials supplied by the provider are never copied.
export const assetRoots = ['home-layout.json', 'profiles', 'data/profiles', 'data/artifacts', 'memory']
const transient = (name) =>
  /(?:\.(?:db|sqlite)(?:-(?:wal|shm|journal))?|\.lock|\.tmp)$/u.test(name) ||
  ['owner.json', '.owner.json'].includes(name) ||
  name.startsWith('.home-layout-') ||
  name.endsWith('-litestream')
export function assetPath(path) {
  safeRelative(path)
  if (
    !assetRoots.some((root) => path === root || path.startsWith(`${root}/`)) ||
    path.split('/').some(transient)
  )
    throw fault('SYNC_ASSET_PATH_INVALID')
  return path
}
async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function copyAtomic(source, destination, mode = 0o600, expectedHash) {
  await privateDirectory(dirname(destination))
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    await copyFile(source, temporary)
    if (expectedHash && (await digest(temporary)) !== expectedHash)
      throw fault('SYNC_ASSET_CHANGED_DURING_COPY')
    await chmod(temporary, mode & 0o100 ? 0o700 : 0o600)
    const fd = await open(temporary, 'r')
    try {
      await fd.sync()
    } finally {
      await fd.close()
    }
    await rename(temporary, destination)
    const directory = await open(dirname(destination), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
}
export async function bindAssets(config) {
  await privateDirectory(config.assets)
  const path = join(config.assets, 'state.json'),
    old = await privateJson(path)
  if (old && JSON.stringify(old) !== JSON.stringify(identity(config)))
    throw fault('SYNC_ASSET_IDENTITY_MISMATCH')
  if (!old) await atomicJson(path, identity(config))
}
const fingerprintCaches = new WeakMap()
const stampOf = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
export async function snapshotAssets(config, signal) {
  const previous = fingerprintCaches.get(config) ?? new Map(),
    cache = new Map()
  const files = []
  async function walk(path) {
    signal?.throwIfAborted()
    await noLinks(config.home, join(config.home, path))
    const source = join(config.home, path),
      stat = await lstat(source).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
    if (!stat) return
    if (stat.isSymbolicLink()) throw fault('SYNC_ASSET_PATH_UNSAFE')
    if (transient(path.split('/').at(-1))) return
    if (stat.isDirectory()) {
      for (const name of await readdir(source)) await walk(`${path}/${name}`)
      return
    }
    if (!stat.isFile()) throw fault('SYNC_ASSET_PATH_UNSAFE')
    assetPath(path)
    const fd = await open(source, 'r'),
      magic = Buffer.alloc(16)
    try {
      await fd.read(magic, 0, 16, 0)
    } finally {
      await fd.close()
    }
    if (magic.equals(Buffer.from('SQLite format 3\0'))) throw fault('SYNC_UNEXPECTED_SQLITE_ASSET')
    const stamp = stampOf(stat)
    const old = previous.get(path)
    const sha256 = old?.stamp === stamp ? old.sha256 : await digest(source),
      target = join(config.assets, 'objects', sha256.slice(0, 2), sha256)
    await noLinks(config.assets, target)
    const existing = await lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw fault('SYNC_ASSET_PATH_UNSAFE')
    if (!existing) {
      await copyAtomic(source, target, stat.mode, sha256)
    } else if (existing.size !== stat.size || (!old && (await digest(target)) !== sha256))
      throw fault('SYNC_ASSET_CORRUPT')
    if (stampOf(await lstat(source)) !== stamp) throw fault('SYNC_ASSET_CHANGED_DURING_COPY')
    cache.set(path, { stamp, sha256 })
    files.push({ path, sha256, size: stat.size, executable: Boolean(stat.mode & 0o100) })
    if (files.length > 100000) throw fault('SYNC_ASSET_LIMIT')
  }
  for (const root of assetRoots) await walk(root)
  fingerprintCaches.set(config, cache)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
export async function restoreAssets(config, files, signal) {
  if (!Array.isArray(files) || files.length > 100000) throw fault('SYNC_MANIFEST_INVALID')
  const seen = new Set()
  for (const entry of files) {
    signal?.throwIfAborted()
    const path = assetPath(entry.path)
    if (
      seen.has(path) ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.executable !== 'boolean'
    )
      throw fault('SYNC_MANIFEST_INVALID')
    seen.add(path)
    const source = join(config.assets, 'objects', entry.sha256.slice(0, 2), entry.sha256)
    await noLinks(config.assets, source)
    await noLinks(config.home, join(config.home, path))
    const stat = await lstat(source)
    if (!stat.isFile() || stat.size !== entry.size || (await digest(source)) !== entry.sha256)
      throw fault('SYNC_ASSET_CORRUPT')
    await copyAtomic(source, join(config.home, path), entry.executable ? 0o700 : 0o600, entry.sha256)
  }
  if (!seen.has('home-layout.json')) throw fault('SYNC_HOME_MARKER_MISSING')
}
