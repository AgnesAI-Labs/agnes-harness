import { HostError } from '@agnes/host-common/errors'
import { createPosixPlatform, type PlatformBackend } from './platform-posix.js'
import { createWin32Platform } from './platform-win32.js'

export { probeLinuxSandboxSupport } from './linux-sandbox-diagnostics.js'
export {
  CAPABILITY_IDS,
  type CapabilityId,
  type CapabilityLevel,
  createPosixPlatform,
  type PlatformBackend,
  type PlatformBackendSatisfiesSeam,
  type SandboxBackendReport,
} from './platform-posix.js'
export { createWin32Platform } from './platform-win32.js'

export function createPlatform(): PlatformBackend {
  const backend = [createPosixPlatform(), createWin32Platform()].find((b) => b.matches())
  if (!backend)
    throw new HostError('E_SEAM_INIT', 'no platform backend matches this OS', {
      detail: { seam: 'platform' },
    })
  return backend
}
