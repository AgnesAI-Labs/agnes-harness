import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function jsonOrMissing(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export const readOwner = (settings) => jsonOrMissing(join(settings.dataDir, 'daemon', 'owner.json'))

export function sameOwner(left, right) {
  if (!left || !right) return !left && !right
  return ['pid', 'processStartId', 'generation'].every((key) => left[key] === right[key])
}

// A home/dataDir may have a daemon for a different Web port. Never stop it as a port side effect.
export async function assertDaemonSelection(settings, expected) {
  const current = await readOwner(settings)
  if (!sameOwner(expected, current)) throw new Error('Daemon owner changed; refusing to stop it.')
  if (!current) return
  const discovery = await jsonOrMissing(join(settings.dataDir, 'daemon', 'discovery.json'))
  if (
    !discovery ||
    !sameOwner(current, discovery.owner) ||
    discovery.profile !== settings.profile ||
    discovery.web?.origin !== `http://127.0.0.1:${settings.port}`
  )
    throw new Error('Daemon is not ready for this profile/Web port; no daemon was stopped.')
}

// Filesystem scope follows the shared daemon, not checkout or port. Aliased paths share the mkdir.
export async function acquireLock(path) {
  try {
    await mkdir(path)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(
      `Another dev transition or interrupted startup owns ${path}. Inspect it before retrying; no services were stopped.`,
      { cause: error },
    )
  }
  try {
    await writeFile(
      join(path, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { flag: 'wx', mode: 0o600 },
    )
  } catch (error) {
    await rmdir(path)
    throw error
  }
  return async () => {
    await unlink(join(path, 'owner.json'))
    await rmdir(path)
  }
}

export async function acquireCleanupLock(path) {
  try {
    return await acquireLock(path)
  } catch (error) {
    if (error.cause?.code !== 'EEXIST') throw error
    return undefined
  }
}
