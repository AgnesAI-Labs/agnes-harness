import type { DatabaseSync } from 'node:sqlite'
import { createPlatform } from './platform.js'

/**
 * Makes this connection's WAL checkpoints reach the storage medium. SQLite keeps a WAL database
 * uncorrupted across a power loss, losing only the newest commits, only if the checkpoint's sync is
 * durable. On darwin a plain fsync leaves the writes in the drive's cache and only F_FULLFSYNC
 * flushes them. Commits themselves stay unsynced by design, so `fullfsync` is deliberately not set.
 * Per connection: call it on every read-write connection that may checkpoint a durable database.
 */
export function syncCheckpointsToMedium(
  db: Pick<DatabaseSync, 'exec'>,
  os: 'darwin' | 'linux' | 'win32' = createPlatform().os,
): void {
  if (os === 'darwin') db.exec('PRAGMA checkpoint_fullfsync = ON')
}
