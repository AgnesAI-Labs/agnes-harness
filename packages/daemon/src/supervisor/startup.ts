import { acquireDaemonMutationLock, DaemonMutationLockError } from './mutation-lock.js'
import type { DaemonScope } from './scope.js'

/** A bounded launcher lock kept separate from the daemon's owner lifetime lock. */
export class DaemonStartupBusyError extends Error {
  override name = 'DaemonStartupBusyError'
  readonly code = 'E_DAEMON_STARTUP_BUSY' as const
  constructor() {
    super('daemon startup is already coordinated by another launcher')
  }
}

/**
 * Serialize launcher check/spawn/wait sequences. The daemon itself only acquires the owner lock,
 * so a launcher may hold this lock while the child is starting without deadlocking the child.
 */
export function acquireDaemonStartup(scope: Pick<DaemonScope, 'dataDir'>): { release(): void } {
  try {
    return acquireDaemonMutationLock(scope.dataDir, 'startup-lock.db')
  } catch (error) {
    if (error instanceof DaemonMutationLockError && error.code === 'E_DAEMON_BUSY')
      throw new DaemonStartupBusyError()
    throw error
  }
}
