import { open } from 'node:fs/promises'

import type { ProcessIdentity } from './process-identity.js'

const unknown = (): ProcessIdentity => ({ state: 'unknown', reason: 'process identity unavailable' })
const code = (error: unknown) =>
  error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
async function boundedRead(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(8193)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 8192) throw new Error('process record too large')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/** Linux /proc snapshot; callers must recheck identity before acting on a PID. */
export async function linuxProcessIdentity(
  pid: number,
  deps: { readText?: (path: string) => Promise<string>; checkAlive?: (pid: number) => void } = {},
): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return unknown()
  const readText = deps.readText ?? boundedRead
  try {
    const boot = (await readText('/proc/sys/kernel/random/boot_id')).trim()
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(boot)) return unknown()
    let stat: string
    try {
      stat = await readText(`/proc/${pid}/stat`)
    } catch (error) {
      if (code(error) !== 'ENOENT') return unknown()
      try {
        ;(deps.checkAlive ?? ((id) => process.kill(id, 0)))(pid)
      } catch (probeError) {
        if (code(probeError) === 'ESRCH') return { state: 'dead' }
      }
      return unknown()
    }
    if (Buffer.byteLength(stat) > 8192 || !stat.startsWith(`${pid} (`)) return unknown()
    const end = stat.lastIndexOf(')')
    if (end < 0 || stat[end + 1] !== ' ') return unknown()
    const fields = stat
      .slice(end + 2)
      .trim()
      .split(/\s+/)
    const ticks = fields[19]
    if (!fields[0] || !/^[RSDZTtWXxKPI]$/.test(fields[0]) || !ticks || !/^[0-9]{1,20}$/.test(ticks))
      return unknown()
    const start = BigInt(ticks)
    if (start > 18_446_744_073_709_551_615n) return unknown()
    return { state: 'alive', startId: `linux:${boot}:${pid}:${start}` }
  } catch {
    return unknown()
  }
}
