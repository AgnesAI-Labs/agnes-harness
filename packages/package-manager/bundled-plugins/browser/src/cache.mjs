import { constants } from 'node:fs'
import { access, lstat, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { failure, isBrowserRefusal } from './policy.mjs'

function invalidCache() {
  return failure(
    'CACHE_INVALID',
    'The browser cache is incomplete or not executable. Stop AGH instances sharing it, move the browser revision directory aside, then re-enable the plugin.',
  )
}

function unsafeCache() {
  return failure(
    'CACHE_UNSAFE',
    'The Linux browser cache must use real directories and files protected from other accounts. Use a private cache location and re-enable the plugin.',
  )
}

async function entryAt(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function trustedOwner(entry) {
  return entry.uid === 0 || entry.uid === process.geteuid()
}

export async function linuxCacheDirectory(path, create = false, ancestor = false) {
  const parent = dirname(path)
  if (parent !== path && !(await linuxCacheDirectory(parent, create, true))) return false
  let entry = await entryAt(path)
  if (!entry && create) {
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    entry = await lstat(path)
  }
  if (!entry) return false
  // A trusted sticky parent such as /tmp protects the next, independently checked entry.
  if (
    !entry.isDirectory() ||
    !trustedOwner(entry) ||
    ((entry.mode & 0o022) !== 0 && !(ancestor && (entry.mode & 0o1000) !== 0))
  )
    throw unsafeCache()
  return true
}

async function verifyLinuxTree(path, entry) {
  if (!trustedOwner(entry) || (entry.mode & 0o022) !== 0) throw unsafeCache()
  if (entry.isDirectory()) {
    for (const name of await readdir(path)) {
      const child = join(path, name)
      await verifyLinuxTree(child, await lstat(child))
    }
  } else if (!entry.isFile() || entry.nlink !== 1) throw unsafeCache()
}

export async function installed(info) {
  if (info.os === 'linux' && !(await linuxCacheDirectory(info.base))) return false
  const cache = await entryAt(info.cache)
  if (!cache) return false
  try {
    if (info.os === 'linux') await verifyLinuxTree(info.cache, cache)
    if (!(await stat(info.cache)).isDirectory()) throw invalidCache()
    const markerPath = join(info.cache, 'agnes-install.json')
    const markerFile = await stat(markerPath)
    if (!markerFile.isFile() || markerFile.size > 4096) throw invalidCache()
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    const executable = await stat(info.executable)
    if (marker?.sha256 !== info.sha256 || !executable.isFile() || executable.size === 0) throw invalidCache()
    await access(info.executable, constants.X_OK)
    for (const file of info.runtimeFiles ?? []) {
      const path = join(info.cache, file.path)
      const entry = await lstat(path)
      if (!entry.isFile() || entry.size !== file.size) throw invalidCache()
      await access(path, file.executable ? constants.R_OK | constants.X_OK : constants.R_OK)
    }
    return true
  } catch (error) {
    if (isBrowserRefusal(error)) throw error
    throw invalidCache()
  }
}
