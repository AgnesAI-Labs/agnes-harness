import { jcs } from '@agnes/protocol'
import type { CommitSideEntry, IntegrityVerifyResult } from '@agnes/protocol/runtime'
import { sha256Hex, utf8 } from '../../request/hash.js'
import { failIntegrity, parseIntegrityVerifyRequest } from './validation.js'

function assertRelation(condition: boolean): void {
  if (!condition) failIntegrity('invalid_input', 'integrity_mismatch')
}
/** Ordering is by UTF8 bytes, including characters whose UTF16 order differs. */
function compareText(left: string, right: string): number {
  const a = utf8(left),
    b = utf8(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const delta = (a[index] as number) - (b[index] as number)
    if (delta !== 0) return delta
  }
  return a.length - b.length
}
function identity(entry: CommitSideEntry): readonly string[] {
  switch (entry.kind) {
    case 'action-created':
      return [entry.kind, entry.actionId]
    case 'outbox-created':
      return [entry.kind, entry.eventId]
    case 'receipt-created':
      return [entry.kind, entry.receiptId]
    case 'signal-consumed':
      return [entry.kind, entry.signalId]
    case 'usage-origin':
      return [entry.kind, entry.sourceAuthorityId, entry.originKey]
  }
}
function compareIdentity(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < a.length; index++) {
    const delta = compareText(a[index] as string, b[index] as string)
    if (delta !== 0) return delta
  }
  return 0
}

/** Verifies this complete manifest only, not unseen State values or historical transaction origin. */
export function verifyIntegrityCommitManifest(input: unknown): IntegrityVerifyResult {
  const request = parseIntegrityVerifyRequest(input)
  if (request.kind !== 'commit-manifest') failIntegrity('invalid_input', 'integrity_input_invalid')
  const mutations = []
  let lastRecord: string | null = null
  for (const row of request.mutations) {
    assertRelation(row.commitId === request.commit.commitId)
    if (lastRecord !== null) assertRelation(compareText(lastRecord, row.recordId) < 0)
    lastRecord = row.recordId
    if (row.next === null) assertRelation(row.previousRevision !== null && row.previousRevision > 0)
    else if (row.previousRevision === null) assertRelation(row.next.recordRevision === 1)
    else
      assertRelation(
        row.previousRevision > 0 &&
          row.previousRevision < Number.MAX_SAFE_INTEGER &&
          row.next.recordRevision === row.previousRevision + 1,
      )
    const { commitId: _removed, ...value } = row
    mutations.push(value)
  }
  const sides = []
  const counts = { createdActions: 0, consumedSignals: 0, outboxEvents: 0, receipts: 0, usageOrigins: 0 }
  let lastSide: readonly string[] | null = null
  for (const row of request.sideEntries) {
    assertRelation(row.commitId === request.commit.commitId)
    const key = identity(row)
    if (lastSide !== null) assertRelation(compareIdentity(lastSide, key) < 0)
    lastSide = key
    switch (row.kind) {
      case 'action-created':
        counts.createdActions++
        break
      case 'outbox-created':
        counts.outboxEvents++
        break
      case 'receipt-created':
        counts.receipts++
        break
      case 'signal-consumed':
        counts.consumedSignals++
        break
      case 'usage-origin':
        counts.usageOrigins++
        break
    }
    const { commitId: _removed, ...value } = row
    sides.push(value)
  }
  const mutationsDigest = sha256Hex(jcs(mutations))
  const sideListsDigest = sha256Hex(jcs(sides))
  assertRelation(request.commit.mutationCount === mutations.length)
  assertRelation(jcs(request.commit.counts) === jcs(counts))
  assertRelation(
    request.commit.mutationsDigest === mutationsDigest && request.commit.sideListsDigest === sideListsDigest,
  )
  return { kind: 'commit-manifest', commitId: request.commit.commitId, mutationsDigest, sideListsDigest }
}
