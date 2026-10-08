import { acquireDaemonMutationLock } from './mutation-lock.js'
import type { DaemonScope } from './scope.js'
import { acquireDaemonStartup } from './startup.js'

/** Excludes every daemon launcher while an offline repair mutates daemon-owned state. */
export function acquireDaemonOfflineMaintenance(scope: Pick<DaemonScope, 'dataDir'>): { release(): void } {
  const startup = acquireDaemonStartup(scope)
  try {
    const mutation = acquireDaemonMutationLock(scope.dataDir)
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
