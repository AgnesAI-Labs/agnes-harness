import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlatform } from '../adapters/platform.js'
import type { ComputerUseLiveProcessIdentity } from './windows-driver-backend.js'

declare const AGNES_PACKAGED_BUILTINS: boolean | undefined
const moduleDir = dirname(fileURLToPath(import.meta.url))

export function macosLiveAppIdentityBinary(
  packaged = typeof AGNES_PACKAGED_BUILTINS !== 'undefined' && AGNES_PACKAGED_BUILTINS,
): string {
  return packaged
    ? join(moduleDir, 'native', 'macos-live-app-identity')
    : join(moduleDir, '..', '..', 'dist', 'native', 'macos-live-app-identity')
}
const ALIVE =
  /^alive ([0-9]{1,20}\.[0-9]{6}) ([0-9]{1,20}\.[0-9]{6}) ([A-Za-z0-9._-]{1,255}) (-|[A-Za-z0-9._-]{1,64}) ([a-f0-9]{64})$/u

export type MacOSLiveAppIdentity = Extract<ComputerUseLiveProcessIdentity, { platform: 'darwin' }>

export function parseMacOSLiveAppIdentity(output: string): MacOSLiveAppIdentity {
  if (output.length > 512) throw new Error('macOS application identity output is oversized')
  const line = output.trim()
  const match = ALIVE.exec(line)
  if (!match) throw new Error('macOS application identity is unavailable')
  return Object.freeze({
    platform: 'darwin',
    processStartTime: `darwin:${match[1]}:${match[2]}`,
    bundleId: match[3] as string,
    ...(match[4] === '-' ? {} : { teamId: match[4] as string }),
    signatureSha256: match[5] as string,
  })
}

/** Security.framework proof for the signed code object attached to this live PID. */
export function macosLiveAppIdentitySync(
  pid: number,
  dependencies: Readonly<{
    run?: (binary: string, args: readonly string[]) => Readonly<{ status: number | null; stdout: string }>
  }> = {},
): MacOSLiveAppIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647)
    throw new TypeError('Expected a positive macOS process ID')
  if (createPlatform().os !== 'darwin' && !dependencies.run)
    throw new Error('macOS application identity is unavailable on this platform')
  const result = dependencies.run
    ? dependencies.run(macosLiveAppIdentityBinary(), [String(pid)])
    : (() => {
        const spawned = spawnSync(macosLiveAppIdentityBinary(), [String(pid)], {
          timeout: 1_000,
          maxBuffer: 1024,
          encoding: 'utf8',
          env: {},
        })
        return { status: spawned.status, stdout: spawned.stdout }
      })()
  if (result.status !== 0) throw new Error('macOS application identity is unavailable')
  return parseMacOSLiveAppIdentity(result.stdout)
}
