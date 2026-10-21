import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { type ByteFailure, packageByteBinding, packageLockByteBinding } from './byte-verification.js'
import { readLock, withLock, writeLock } from './lockfile.js'
import { packageDir } from './sources.js'

/** A fault only removes a grant. It never trusts bytes, rewrites a tree, or enters the normal
 * untrust transaction, which intentionally verifies the old tree and checks active references. */
export async function revokePackageByteFailure(
  profileDir: string,
  dataDir: string,
  failure: ByteFailure,
): Promise<readonly string[]> {
  return withLock(profileDir, async () => {
    if (
      failure.lockBinding
        ? packageLockByteBinding(profileDir) !== failure.lockBinding
        : packageByteBinding(profileDir) !== failure.binding
    )
      return []
    const lock = readLock(profileDir, { profile: basename(profileDir), agnesVersion: '0.0.0' })
    let ids = failure.identity.packageId
      ? [failure.identity.packageId]
      : Object.keys(lock.packages).filter(
          (id) => resolve(packageDir(dataDir, basename(profileDir), id)) === resolve(failure.directory),
        )
    if (!ids.length) {
      // Generation metadata is already read/validated by the archive reader; a resource tree
      // failure conservatively revokes its source packages, while retaining every durable pin.
      const root = join(profileDir, '.runtime-generations')
      for (let path = resolve(failure.directory); path.startsWith(`${root}${sep}`); path = dirname(path)) {
        try {
          const record = JSON.parse(readFileSync(join(path, 'generation.json'), 'utf8'))
          ids = record.sources.map((source: { snapshot: { packageId: string } }) => source.snapshot.packageId)
          break
        } catch {
          /* Continue to the enclosing immutable generation record. */
        }
      }
    }
    if (!ids.length) throw new Error('package integrity fault has no managed source')
    const changed: string[] = []
    for (const id of new Set(ids)) {
      const entry = lock.packages[id]
      if (!entry || entry.state.trusted === null) continue
      entry.state.trusted = null
      entry.state.enabled = false
      delete entry.trustDecision
      if (entry.provenance) entry.provenance.trustDecision = 'revoked'
      changed.push(id)
    }
    if (changed.length) writeLock(profileDir, lock)
    return changed
  })
}
