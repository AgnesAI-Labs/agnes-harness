import type { SessionEnvironmentAuthority } from '@agnes/daemon-rpc/local/methods/session-environment'
import type { WorkerPool } from '../supervisor/worker-pool.js'

/** The session-key prefix of the sessions the bundled application owns; a session environment is accepted for no other. */
export const BUNDLED_APP_SESSION_PREFIX = 'superagent:'

/**
 * Session environments for the bundled application's own sessions. The shared session worker, which applies them to
 * each command, also writes and removes them, so what it remembers of them is never stale.
 */
export function sessionEnvironmentAuthority(
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
): SessionEnvironmentAuthority {
  const command = async (
    method: 'sessionEnvironment.write' | 'sessionEnvironment.release',
    params: object,
  ) => {
    await (await pool.acquireSharedWorker()).command(method, params as Record<string, unknown>)
  }
  return Object.freeze({
    owns: (sessionKey: string) => sessionKey.startsWith(BUNDLED_APP_SESSION_PREFIX),
    write: (sessionKey, environment) => command('sessionEnvironment.write', { sessionKey, environment }),
    release: (sessionKey) => command('sessionEnvironment.release', { sessionKey }),
  })
}
