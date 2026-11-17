import { defaultProcessIdentity } from '@agnes/host'
import { type Owner, readOwner } from '../src/supervisor/owner-record.js'

/** Discover only the child we spawned; a replacement generation needs a fresh discovery. */
export async function childDaemonTransport(home: string, childPid: number | undefined) {
  if (!Number.isSafeInteger(childPid) || !childPid || childPid <= 0)
    throw new Error('child daemon PID unavailable')
  const owner = await readOwner(home)
  if (!owner || owner.pid !== childPid) throw new Error('child daemon owner changed')
  const sameOwner = (current: Owner | null) =>
    current?.pid === owner.pid &&
    current.processStartId === owner.processStartId &&
    current.generation === owner.generation &&
    current.socketPath === owner.socketPath
  const resolveServerIdentity = async () => {
    if (!sameOwner(await readOwner(home))) throw new Error('child daemon owner changed')
    const identity = await defaultProcessIdentity(owner.pid)
    if (identity.state !== 'alive' || identity.startId !== owner.processStartId)
      throw new Error('child daemon identity unavailable')
    if (!sameOwner(await readOwner(home))) throw new Error('child daemon owner changed')
    return { pid: owner.pid, processStartId: owner.processStartId }
  }
  await resolveServerIdentity()
  return {
    kind: 'unix' as const,
    path: owner.socketPath,
    ...(owner.socketPath.startsWith('\\\\.\\pipe\\') ? { resolveServerIdentity } : {}),
  }
}
