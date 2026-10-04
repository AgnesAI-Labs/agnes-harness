import type { SessionImpl } from '@agnes/core'
import type { SessionOwnerEvidenceStore } from '../adapters/session-owner-evidence.js'

const pending = new WeakSet<object>()

/** A sealed log alone is insufficient when Host capability drain or its close receipt failed. */
export const hasPendingOwnerClose = (session: object): boolean => pending.has(session)

/** Capture the acquisition token now, never look up the latest owner when closing. */
export function sessionOwnerCloseFinalizer(
  session: SessionImpl,
  storage: SessionOwnerEvidenceStore,
  unbind: () => Promise<void>,
): () => Promise<void> {
  const ownerEpoch = session.d.log.ownerEpoch
  const owner =
    ownerEpoch === undefined
      ? undefined
      : {
          sessionKey: session.key,
          writerRunId: session.writerRunId,
          ownerEpoch,
        }
  let finishing: Promise<void> | undefined
  return () => {
    if (finishing) return finishing
    pending.add(session)
    finishing = (async () => {
      await unbind()
      // Adapters without a durable acquisition identity leave closure unknown.
      if (owner) await storage.recordSessionOwnerClosed(owner, session.lastSeq)
      pending.delete(session)
    })().catch((error: unknown) => {
      finishing = undefined
      throw error
    })
    return finishing
  }
}
