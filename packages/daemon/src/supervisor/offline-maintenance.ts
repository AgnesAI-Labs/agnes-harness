import { readStageZero, type StageZeroView } from '@agnes/host'
import { acquireDaemonMutationLock } from './mutation-lock.js'
import type { DaemonScope } from './scope.js'
import { acquireDaemonStartup } from './startup.js'

/** Excludes every daemon launcher while an offline repair mutates daemon-owned state. */
export function acquireDaemonOfflineMaintenance(
  scope: Pick<DaemonScope, 'dataDir'>,
  locator?: { readonly anchor: string; readonly expectedEpoch: number },
): { release(): void } {
  function checkLocator(): void {
    if (!locator) return
    const current = readOfflineMaintenanceLocator(locator.anchor)
    if (current.locator.epoch !== locator.expectedEpoch)
      throw new Error('Maintenance locator epoch is uncertain')
  }
  checkLocator()
  const startup = acquireDaemonStartup(scope)
  try {
    const mutation = acquireDaemonMutationLock(scope.dataDir)
    try {
      checkLocator()
    } catch (error) {
      mutation.release()
      throw error
    }
    let released = false
    return {
      release() {
        if (released) return
        released = true
        try {
          mutation.release()
        } finally {
          startup.release()
        }
      },
    }
  } catch (error) {
    startup.release()
    throw error
  }
}

/** Deployment diagnostics read the external trust anchor without loading a business plugin. */
export function readOfflineMaintenanceLocator(anchor: string): StageZeroView {
  const current = readStageZero(anchor)
  if (!current.ok) throw new Error(`Maintenance locator unavailable: ${current.error.detailCode}`)
  if (!current.value) throw new Error('Maintenance locator unavailable: anchor_absent')
  return current.value
}

