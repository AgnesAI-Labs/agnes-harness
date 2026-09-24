import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProcessIdentity } from './process-identity.js'

// macOS has no readable /proc equivalent, so unlike process-identity-linux.ts this backend
// shells out to a tiny compiled helper (packages/host/native/macos-process-identity.c) that
// calls libproc + sysctl directly. The helper is built by scripts/build-native.mjs; its exact
// output contract is documented at the top of the .c file and mirrored in the parsing below.
declare const AGNES_PACKAGED_BUILTINS: boolean | undefined
const moduleDir = dirname(fileURLToPath(import.meta.url))

export function macosProcessIdentityBinary(
  packaged = typeof AGNES_PACKAGED_BUILTINS !== 'undefined' && AGNES_PACKAGED_BUILTINS,
): string {
  return packaged
    ? join(moduleDir, 'native', 'macos-process-identity')
    : join(moduleDir, '..', '..', 'dist', 'native', 'macos-process-identity')
}

const unknown = (reason: string): ProcessIdentity => ({ state: 'unknown', reason })

// A single alive line, bounded in both digit count and fractional precision so a compromised or
// mismatched-version binary cannot smuggle an oversized or ambiguous value through as a startId.
const ALIVE = /^alive ([0-9]{1,20}\.[0-9]{1,6}) ([0-9]{1,20}\.[0-9]{1,6})$/

function defaultSpawn(bin: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    // maxBuffer/timeout are defense in depth: owner-lock.ts's identity() wrapper already applies
    // a 3000ms deadline around the whole processIdentity() call, but this backend must not hang
    // forever (or buffer unboundedly) if invoked directly, outside that wrapper.
    execFile(bin, args, { timeout: 2_000, maxBuffer: 4096 }, (error, stdout) => {
      if (error && typeof error.code !== 'number') {
        // The helper could not be spawned at all (missing binary, not executable, killed by the
        // timeout's signal) rather than exiting with one of its three defined codes. Reject so the
        // caller's catch-all below turns this into 'unknown', never 'dead'.
        reject(error)
        return
      }
      resolve({ stdout: stdout.toString(), code: error ? (error.code as number) : 0 })
    })
  })
}

/**
 * macOS ProcessIdentity backend. Spawns the compiled libproc helper; never throws — any failure
 * to spawn, parse, or recognize the helper's answer degrades to `{ state: 'unknown' }`, which
 * owner-lock.ts's caller already treats conservatively (never as proof the PID is free to reuse).
 */
export async function macosProcessIdentity(
  pid: number,
  deps: { spawn?: (bin: string, args: string[]) => Promise<{ stdout: string; code: number }> } = {},
): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return unknown('invalid pid')
  const spawn = deps.spawn ?? defaultSpawn
  let result: { stdout: string; code: number }
  try {
    result = await spawn(macosProcessIdentityBinary(), [String(pid)])
  } catch {
    return unknown('helper unavailable')
  }
  if (result.stdout.length > 256) return unknown('helper output too large')
  // Only the first line is trusted; anything the helper prints after that (it shouldn't print
  // anything else, but a future/mismatched binary version might) is ignored rather than parsed.
  const line = (result.stdout.split('\n', 1)[0] ?? '').trim()
  if (result.code === 0) {
    const match = ALIVE.exec(line)
    if (!match) return unknown('malformed alive output')
    return { state: 'alive', startId: `darwin:${match[1]}:${pid}:${match[2]}` }
  }
  if (result.code === 1) return line === 'dead' ? { state: 'dead' } : unknown('malformed dead output')
  if (result.code === 2 && line.startsWith('unknown ') && /^[!-~]+$/.test(line.slice(8)))
    return unknown(line.slice(8))
  return unknown('helper reported an unrecognized outcome')
}
