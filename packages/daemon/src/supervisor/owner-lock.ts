import { randomUUID } from 'node:crypto'
import { open, rename, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProcessIdentity } from '@agnes/host'
import { acquireDaemonMutationLock } from './mutation-lock.js'
import { encodeOwner, type Owner, readOwner } from './owner-record.js'

export class OwnerLockError extends Error {
  override name = 'OwnerLockError'
  constructor() {
    super('daemon owner identity unavailable or already active')
  }
}
async function identity(
  pid: number,
  query: (pid: number) => Promise<ProcessIdentity>,
): Promise<ProcessIdentity> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const found = await Promise.race([
      Promise.resolve().then(() => query(pid)),
      new Promise<ProcessIdentity>((resolve) => {
        timer = setTimeout(() => resolve({ state: 'unknown', reason: 'identity deadline' }), 3_000)
      }),
    ])
    if (found?.state === 'dead') return { state: 'dead' }
    if (
      found?.state === 'alive' &&
      typeof found.startId === 'string' &&
      found.startId.length > 0 &&
      found.startId.length <= 256 &&
      ![...found.startId].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
    )
      return { state: 'alive', startId: found.startId }
    return { state: 'unknown', reason: 'invalid or unavailable identity' }
  } catch {
    return { state: 'unknown', reason: 'identity query failed' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
export async function acquireOwnerLock(
  dataDir: string,
  options: {
    socketPath: string
    processIdentity: (pid: number) => Promise<ProcessIdentity>
  },
): Promise<{ owner: Owner; release(): Promise<void> }> {
  const guard = acquireDaemonMutationLock(dataDir)
  let temporary: string | undefined
  try {
    const old = await readOwner(dataDir)
    if (old) {
      const found = await identity(old.pid, options.processIdentity)
      if (found.state !== 'dead' && !(found.state === 'alive' && found.startId !== old.processStartId))
        throw new OwnerLockError()
    }
    const self = await identity(process.pid, options.processIdentity)
    if (self.state !== 'alive') throw new OwnerLockError()
    const owner: Owner = {
      pid: process.pid,
      processStartId: self.startId,
      generation: randomUUID(),
      startedAt: new Date().toISOString(),
      socketPath: options.socketPath,
    }
    const encoded = encodeOwner(owner)
    const file = join(dataDir, 'daemon', 'owner.json')
    temporary = join(dataDir, 'daemon', `owner.${owner.generation}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(encoded)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    temporary = undefined
    let releasing: Promise<void> | undefined
    return {
      owner: { ...owner },
      release() {
        releasing ??= (async () => {
          try {
            const current = await readOwner(dataDir)
            if (current) {
              if (
                current.generation !== owner.generation ||
                current.pid !== owner.pid ||
                current.processStartId !== owner.processStartId
              )
                throw new OwnerLockError()
              await unlink(file)
            }
          } finally {
            guard.release()
          }
        })().catch(() => {
          throw new OwnerLockError()
        })
        return releasing
      },
    }
  } catch {
    try {
      if (temporary !== undefined) await rm(temporary, { force: true })
    } catch {
      // Keep the public failure fixed even when temporary cleanup fails.
    }
    try {
      guard.release()
    } catch {
      // The guard's own release attempts close before reporting failure.
    }
    throw new OwnerLockError()
  }
}
