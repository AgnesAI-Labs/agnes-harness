import { windowsProcessStartTimeSync } from '@agnes/system-node'
import type { ProcessIdentity } from './process-identity.js'

/** Identity snapshot only: callers must revalidate before taking action on a PID. */
export async function windowsProcessIdentity(
  pid: number,
  deps: { query?: (pid: number) => string | null } = {},
): Promise<ProcessIdentity> {
  const unknown = (): ProcessIdentity => ({ state: 'unknown', reason: 'process identity unavailable' })
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) return unknown()
  try {
    const time = (deps.query ?? windowsProcessStartTimeSync)(pid)
    if (time === null) return { state: 'dead' }
    if (typeof time !== 'string' || !/^[1-9][0-9]{0,19}$/.test(time) || BigInt(time) > 18446744073709551615n)
      return unknown()
    return { state: 'alive', startId: `win32:${pid}:${time}` }
  } catch {
    return unknown()
  }
}
