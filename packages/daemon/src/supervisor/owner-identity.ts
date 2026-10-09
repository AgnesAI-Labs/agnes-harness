import { createHash, randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { legacyMacosProcessIdentity, type ProcessIdentity } from '@agnes/host'
import { encodeOwner, type Owner, readOwnerFile } from './owner-record.js'

const legacy = /^darwin:([1-9][0-9]{0,19}\.[0-9]{6}):([1-9][0-9]*):([1-9][0-9]{0,19}\.[0-9]{6})$/u
const current =
  /^darwin:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):([1-9][0-9]*):([1-9][0-9]{0,19}\.[0-9]{6})$/u

/** Preserve old owner/discovery bytes so a still-running old daemon can release its own lock.
 * An exact legacy probe anchors that owner to an immutable boot. A later calendar drift may use
 * this witness, but an unanchored legacy mismatch is unknown, never proof of a stale owner. */
export async function resolveOwnerIdentity(
  dataDir: string,
  owner: Owner,
  found: ProcessIdentity,
): Promise<ProcessIdentity> {
  if (found.state !== 'alive' || found.startId === owner.processStartId) return found
  const unknown: ProcessIdentity = { state: 'unknown', reason: 'legacy owner boot identity unavailable' }
  const old = legacy.exec(owner.processStartId)
  if (!old)
    return owner.processStartId.startsWith('darwin:') && !current.test(owner.processStartId) ? unknown : found
  const fresh = current.exec(found.startId)
  if (!fresh || Number(old[2]) !== owner.pid || Number(fresh[2]) !== owner.pid) return unknown
  if (old[3] !== fresh[3]) return found // Same PID, different saved process-instance start.
  const digest = createHash('sha256').update(encodeOwner(owner)).digest('hex')
  const file = join(dataDir, 'daemon', `legacy-identity-${digest}.json`)
  try {
    const witness = await readOwnerFile(file, true)
    if (witness) {
      const anchored = current.exec(witness.processStartId)
      if (
        !anchored ||
        Number(anchored[2]) !== owner.pid ||
        anchored[3] !== old[3] ||
        witness.pid !== owner.pid ||
        witness.generation !== owner.generation ||
        witness.startedAt !== owner.startedAt ||
        witness.socketPath !== owner.socketPath
      )
        return unknown
      return witness.processStartId === found.startId
        ? { state: 'alive', startId: owner.processStartId }
        : found // Different boot or process instance, even when PID and calendar fields coincide.
    }
    const probe = await legacyMacosProcessIdentity(owner.pid)
    if (
      probe.identity.state !== 'alive' ||
      probe.identity.startId !== found.startId ||
      probe.legacyStartId !== owner.processStartId
    )
      return unknown
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(encodeOwner({ ...owner, processStartId: found.startId }))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
    return { state: 'alive', startId: owner.processStartId }
  } catch {
    return unknown
  }
}
