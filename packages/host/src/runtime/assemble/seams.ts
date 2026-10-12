import type { SandboxSeam, SeamImplementations } from '@agnes/core'
import type { PlatformBackend } from '@agnes/host-infrastructure/adapters/platform'
import { createSandboxSeam } from '@agnes/host-infrastructure/sandbox-seam'

/**
 * The two build-time seams. Both are Host-owned: `sandbox` is the shell the Host fits to each
 * workspace over the selected `sandbox` provider (or the remote channel), and `platform` is the
 * Host's own backend. The other seams are ordinary Cordis rows. `sandbox` is replaceable only so
 * fixtures can avoid spawning real commands.
 */
export function createStaticSeams(
  platform: PlatformBackend,
  sandbox: SandboxSeam = createSandboxSeam(),
): Pick<SeamImplementations, 'sandbox' | 'platform'> {
  return Object.freeze({ sandbox, platform })
}
