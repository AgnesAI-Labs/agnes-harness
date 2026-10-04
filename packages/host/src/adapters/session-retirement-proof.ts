import type { DatabaseSync } from 'node:sqlite'
import { CoreError } from '@agnes/core'
import type { SessionOwnerIdentity } from './session-owner-evidence.js'
import type { SessionTreeInspection, SessionTreeMember } from './session-retirement-sqlite.js'

export interface SessionTreeRetirementIdentity {
  rootSessionKey: string
  retirementId: string
  epoch: number
}
export interface ClosedSessionTree extends SessionTreeRetirementIdentity {
  members: Array<
    Pick<SessionTreeMember, 'sessionKey' | 'parentKey' | 'kind'> & {
      owner: SessionOwnerIdentity
      finalSeq: number
    }
  >
  purged: boolean
}

/** Called under the Core database write lock. No absence or transport response proves closure. */
export function confirmClosedSessionTree(
  db: DatabaseSync,
  input: SessionTreeRetirementIdentity,
  current: SessionTreeInspection,
  head: (key: string) => number,
): ClosedSessionTree {
  const refuse = (reason: string): never => {
    throw new CoreError('E_RELATION', `Session tree close proof refused: ${reason}`)
  }
  if (current.sealed?.retirementId !== input.retirementId || current.sealed.epoch !== input.epoch)
    refuse('retirement identity mismatch')
  const keys = new Set(current.members.map((member) => member.sessionKey))
  if (!keys.has(input.rootSessionKey) || keys.size !== current.members.length)
    refuse('incomplete permanent membership')
  if (current.writerClaims.length || current.openTurns.length || current.externalHistoryDependents.length)
    refuse('writers, active turns or external history dependents remain')
  const purge = db
    .prepare('SELECT retirement_id,epoch,final_heads FROM session_tree_purges WHERE root_session_key=?')
    .get(input.rootSessionKey)
  if (purge && (purge.retirement_id !== input.retirementId || purge.epoch !== input.epoch))
    refuse('purge identity mismatch')
  const members = current.members
    .map((member) => {
      const seen = new Set<string>()
      let cursor = member
      while (cursor.sessionKey !== input.rootSessionKey) {
        if (seen.has(cursor.sessionKey) || cursor.kind !== 'delegated') refuse('invalid lineage')
        seen.add(cursor.sessionKey)
        const parent = current.members.find((row) => row.sessionKey === cursor.parentKey)
        if (!parent) return refuse('incomplete lineage')
        cursor = parent
      }
      if (cursor.parentKey !== null || cursor.kind !== 'root') refuse('invalid root')
      const evidence = current.ownerEvidence.find((row) => row.sessionKey === member.sessionKey)?.evidence
      if (
        !evidence?.closed ||
        evidence.owner.sessionKey !== member.sessionKey ||
        !Number.isSafeInteger(evidence.owner.ownerEpoch) ||
        evidence.owner.ownerEpoch < 1 ||
        !Number.isSafeInteger(evidence.closed.finalSeq) ||
        evidence.closed.finalSeq < 0
      )
        return refuse('exact owner closure is unknown')
      if (!purge) {
        const stored = db
          .prepare('SELECT format_version FROM sessions WHERE session_key=?')
          .get(member.sessionKey)
        if (stored?.format_version !== 1 || head(member.sessionKey) !== evidence.closed.finalSeq)
          refuse('closed final head changed')
        if (
          member.kind === 'delegated' &&
          (!['completed', 'failed', 'cancelled', 'interrupted'].includes(member.state ?? '') ||
            !['committed', 'cancelled'].includes(member.creationPhase ?? ''))
        )
          refuse('delegated member is not terminal')
        for (const row of db
          .prepare(
            "SELECT register,data FROM registers WHERE session_key=? AND register IN ('op.state','inbox')",
          )
          .all(member.sessionKey)) {
          if (row.register === 'op.state' && row.data !== 'null') refuse('active program counter')
          if (row.register === 'inbox') {
            const data = JSON.parse(String(row.data)) as { items?: unknown }
            if (!Array.isArray(data.items) || data.items.length) refuse('pending or unknown input queue')
          }
        }
      }
      return {
        sessionKey: member.sessionKey,
        parentKey: member.parentKey,
        kind: member.kind,
        owner: evidence.owner,
        finalSeq: evidence.closed.finalSeq,
      }
    })
    .sort((a, b) => (a.sessionKey < b.sessionKey ? -1 : a.sessionKey > b.sessionKey ? 1 : 0))
  if (
    purge &&
    purge.final_heads !==
      JSON.stringify(members.map(({ sessionKey, finalSeq }) => ({ sessionKey, finalSeq })))
  )
    refuse('purge final heads do not match current owner evidence')
  return { ...input, members, purged: purge !== undefined }
}
