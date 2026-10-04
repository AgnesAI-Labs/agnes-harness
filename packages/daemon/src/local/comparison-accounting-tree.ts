import type { ScopedComparisonStore } from '@agnes/host'
import type { ComparisonTreeCut, RuntimeIdentity } from '@agnes/protocol'
import type { ComparisonRecord, Side } from '@agnes/runtime-comparison'

/** Resolve only the selected journal observation. Final archives may complete the final released
 * prefix, but never retroactively supply children or later usage to an older journal position. */
export async function comparisonAccountingTree(
  store: ScopedComparisonStore,
  record: ComparisonRecord,
  side: Side,
  atSeq: number,
  rootThroughSeq: number,
): Promise<ComparisonTreeCut> {
  const lane = record.lanes[side]
  if (!lane) throw new Error('Comparison lane unavailable')
  const cut = (await store.journal.treeCutsAt(record.id, atSeq))?.[side]
  if (record.retirement?.state === 'released' && (await store.journal.head(record.id))?.seq === atSeq) {
    const archive = store.treeArchive.read(record.id, side)
    if (
      archive &&
      archive.proof.rootSessionKey === lane.sessionId &&
      archive.proof.epoch === record.retirement.epoch &&
      archive.proof.members.find((member) => member.sessionKey === lane.sessionId)?.finalSeq ===
        rootThroughSeq
    ) {
      const members: ComparisonTreeCut['members'] = []
      for (const member of archive.proof.members) {
        const rows = archive.members.find((value) => value.sessionKey === member.sessionKey)?.rows
        const own = rows?.find((row) => row.sessionKey === member.sessionKey)
        const start = own?.event
        const data = start?.data as
          | { key?: unknown; runtime?: RuntimeIdentity; parent?: { boundarySeq?: unknown } }
          | undefined
        if (
          !own ||
          start?.type !== 'session/start' ||
          start.origin !== 'system' ||
          start.trust !== 'trusted' ||
          data?.key !== member.sessionKey
        )
          return { members, complete: false, issues: ['archive_member_identity_unknown'] }
        const inheritedThroughSeq = start.seq - 1
        if (inheritedThroughSeq > 0 && data.parent?.boundarySeq !== inheritedThroughSeq)
          return { members, complete: false, issues: ['archive_inheritance_unknown'] }
        members.push({
          sessionId: member.sessionKey,
          parentSessionId: member.parentKey,
          runtime: data.runtime ?? { id: 'native', version: '1' },
          inheritedThroughSeq,
          throughSeq: member.finalSeq,
        })
      }
      return { members, complete: true, issues: [] }
    }
  }
  if (cut) {
    const root = cut.members.find((member) => member.sessionId === lane.sessionId)
    if (
      root?.throughSeq !== rootThroughSeq ||
      root.runtime.id !== lane.runtime.id ||
      root.runtime.version !== lane.runtime.version
    )
      throw new Error('Comparison tree root binding mismatch')
    return structuredClone(cut)
  }
  return {
    complete: false,
    issues: ['missing_tree_cut'],
    members: [
      {
        sessionId: lane.sessionId,
        parentSessionId: null,
        runtime: lane.runtime,
        inheritedThroughSeq: 0,
        throughSeq: rootThroughSeq,
      },
    ],
  }
}
