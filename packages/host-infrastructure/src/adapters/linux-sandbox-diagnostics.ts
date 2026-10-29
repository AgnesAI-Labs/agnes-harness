import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { linuxLandlockAbiSync } from '@agnes/system-node'

const execute = promisify(execFile)

/** Diagnostic only; Base still verifies the complete boundary before granting L1. */
export async function probeLinuxSandboxSupport(
  deps: { bubblewrap?: () => Promise<void>; landlockAbi?: () => number } = {},
): Promise<{ bubblewrap: 'installed' | 'missing' | 'unknown'; landlockAbi: number | 'unknown' }> {
  let bubblewrap: 'installed' | 'missing' | 'unknown' = 'unknown'
  let landlockAbi: number | 'unknown' = 'unknown'
  try {
    await (
      deps.bubblewrap ??
      (async () => {
        await execute('bwrap', ['--version'], { timeout: 2000, maxBuffer: 4096 })
      })
    )()
    bubblewrap = 'installed'
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      bubblewrap = 'missing'
  }
  try {
    const abi = (deps.landlockAbi ?? linuxLandlockAbiSync)()
    if (Number.isSafeInteger(abi) && abi >= 0) landlockAbi = abi
  } catch {
    // Permission denial, a stale native helper, or an unknown kernel stays unknown.
  }
  return { bubblewrap, landlockAbi }
}
