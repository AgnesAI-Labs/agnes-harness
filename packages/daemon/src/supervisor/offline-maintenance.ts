import { acquireDaemonMutationLock } from './mutation-lock.js'
import type { DaemonScope } from './scope.js'
import { acquireDaemonStartup } from './startup.js'

/** Excludes every daemon launcher while an offline repair mutates daemon-owned state. */
export function acquireDaemonOfflineMaintenance(scope: Pick<DaemonScope, 'home' | 'dataDir'>): {
  release(): void
} {
  const startup = acquireDaemonStartup(scope)
  try {
    const mutation = acquireDaemonMutationLock(scope.home)
    let data: { release(): void } | undefined
    try {
      if (scope.home !== scope.dataDir) data = acquireDaemonMutationLock(scope.dataDir)
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
          try {
            data?.release()
          } finally {
            mutation.release()
          }
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
