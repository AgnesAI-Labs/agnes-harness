import { createPlatform, type PlatformBackend } from './platform.js'
import type { ProcessIdentity } from './process-identity.js'
import { linuxProcessIdentity } from './process-identity-linux.js'
import { macosProcessIdentity } from './process-identity-macos.js'
import { windowsProcessIdentity } from './process-identity-win32.js'

/**
 * Picks the OS-appropriate ProcessIdentity backend. The OS comes from a PlatformBackend — this
 * codebase's one sanctioned way to ask what OS this is (see test/boundary.test.ts: raw runtime
 * platform checks are confined to platform-posix.ts / platform-win32.ts) — rather than from a
 * raw runtime platform check of its own. Production callers (e.g. daemon's supervisor wiring
 * acquireOwnerLock) can call this with no second argument; tests inject a minimal `{ os }` stub
 * instead of a full PlatformBackend.
 */
export async function defaultProcessIdentity(
  pid: number,
  platform: Pick<PlatformBackend, 'os'> = createPlatform(),
): Promise<ProcessIdentity> {
  if (platform.os === 'linux') return linuxProcessIdentity(pid)
  if (platform.os === 'darwin') return macosProcessIdentity(pid)
  if (platform.os === 'win32') return windowsProcessIdentity(pid)
  return { state: 'unknown', reason: 'unsupported platform' }
}
