import { createHash } from 'node:crypto'
import { jcs } from '@agnes/protocol'
import type { CommitMutationManifest, CommitSideEntry, IntegrityVerifyRequest } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { verifyIntegrityCommitManifest } from '../../src/runtime/integrity/commit-manifest.js'

const hash = (value: unknown): string => createHash('sha256').update(jcs(value)).digest('hex')
const next = {
  recordRevision: 1,
  schema: { typeId: 'test/record@1', revision: 1, digest: 'a'.repeat(64) },
  digest: 'b'.repeat(64),
}
function request(
  mutations: CommitMutationManifest[] = [],
  sideEntries: CommitSideEntry[] = [],
): Extract<IntegrityVerifyRequest, { kind: 'commit-manifest' }> {
  const counts = { createdActions: 0, outboxEvents: 0, receipts: 0, consumedSignals: 0, usageOrigins: 0 }
  for (const entry of sideEntries) {
    const key = {
      'action-created': 'createdActions',
      'outbox-created': 'outboxEvents',
      'receipt-created': 'receipts',
      'signal-consumed': 'consumedSignals',
      'usage-origin': 'usageOrigins',
    } as const
    counts[key[entry.kind]]++
  }
  return {
    kind: 'commit-manifest',
    mutations,
    sideEntries,
    commit: {
      commitId: 'commit',
      transactionFingerprint: 'a'.repeat(64),
      runId: null,
      actionId: null,
      authorityEpoch: 1,
      writerEpoch: 1,
      previousCommitId: null,
      mutationsDigest: hash(mutations.map(({ commitId: _removed, ...value }) => value)),
      sideListsDigest: hash(sideEntries.map(({ commitId: _removed, ...value }) => value)),
      mutationCount: mutations.length,
      counts,
    },
  }
}
const mutation = (recordId: string): CommitMutationManifest => ({
  commitId: 'commit',
  recordId,
  previousRevision: null,
  next,
})
const usage = (sourceAuthorityId: string, originKey: string): CommitSideEntry => ({
  commitId: 'commit',
  kind: 'usage-origin',
  sourceAuthorityId,
  originKey,
})

describe('default Integrity commit manifest', () => {
  it('accepts empty and complete create/update/delete manifests with all five side kinds', () => {
    expect(verifyIntegrityCommitManifest(request())).toMatchObject({
      commitId: 'commit',
      mutationsDigest: hash([]),
      sideListsDigest: hash([]),
    })
    const sides: CommitSideEntry[] = [
      { commitId: 'commit', kind: 'action-created', actionId: 'action' },
      { commitId: 'commit', kind: 'outbox-created', eventId: 'outbox' },
      { commitId: 'commit', kind: 'receipt-created', receiptId: 'receipt' },
      { commitId: 'commit', kind: 'signal-consumed', signalId: 'signal' },
      usage('authority', 'origin'),
    ]
    const mutations = [
      mutation('a'),
      { ...mutation('b'), previousRevision: 1, next: { ...next, recordRevision: 2 } },
      { ...mutation('c'), previousRevision: 2, next: null },
    ]
    const input = request(mutations, sides)
    expect(verifyIntegrityCommitManifest(input)).toEqual({
      kind: 'commit-manifest',
      commitId: 'commit',
      mutationsDigest: input.commit.mutationsDigest,
      sideListsDigest: input.commit.sideListsDigest,
    })
  })
  it('uses UTF8 sort and distinct usage tuples rather than joined-string identity', () => {
    expect(verifyIntegrityCommitManifest(request([mutation('\ue000'), mutation('😀')])).kind).toBe(
      'commit-manifest',
    )
    expect(() => verifyIntegrityCommitManifest(request([mutation('😀'), mutation('\ue000')]))).toThrow()
    expect(verifyIntegrityCommitManifest(request([], [usage('a', 'bc'), usage('ab', 'c')])).kind).toBe(
      'commit-manifest',
    )
    expect(() => verifyIntegrityCommitManifest(request([], [usage('a', 'bc'), usage('a', 'bc')]))).toThrow()
  })
  it('rejects wrong commit IDs, duplicates, out-of-order members, digest and actual count disagreement', () => {
    for (const mutations of [
      [mutation('a'), mutation('a')],
      [mutation('b'), mutation('a')],
      [{ ...mutation('a'), commitId: 'other' }],
    ])
      expect(() => verifyIntegrityCommitManifest(request(mutations))).toThrow()
    const side: CommitSideEntry = { commitId: 'commit', kind: 'action-created', actionId: 'action' }
    for (const sides of [[side, side], [{ ...side, commitId: 'other' }], [usage('b', 'origin'), side]])
      expect(() => verifyIntegrityCommitManifest(request([], sides))).toThrow()
    const input = request([mutation('a')], [side])
    for (const commit of [
      { ...input.commit, mutationCount: 2 },
      { ...input.commit, counts: { ...input.commit.counts, createdActions: 0 } },
      { ...input.commit, mutationsDigest: '0'.repeat(64) },
      { ...input.commit, sideListsDigest: '0'.repeat(64) },
    ])
      expect(() => verifyIntegrityCommitManifest({ ...input, commit })).toThrow()
  })
  it('rejects invalid revision relationships even if the caller rehashes every supplied member', () => {
    for (const row of [
      { ...mutation('a'), next: null },
      { ...mutation('a'), previousRevision: 0 },
      { ...mutation('a'), next: { ...next, recordRevision: 2 } },
      { ...mutation('a'), previousRevision: 2, next: { ...next, recordRevision: 2 } },
      {
        ...mutation('a'),
        previousRevision: Number.MAX_SAFE_INTEGER,
        next: { ...next, recordRevision: Number.MAX_SAFE_INTEGER },
      },
      { ...mutation('a'), previousRevision: -0 },
    ])
      expect(() => verifyIntegrityCommitManifest(request([row]))).toThrow()
  })
  it('rejects closed-wrapper violations, incomplete material and work/collection quota overflow', () => {
    const input = request()
    for (const bad of [
      { ...input, extra: true },
      { ...input, commit: { ...input.commit, extra: true } },
      { ...input, mutations: [{ recordId: 'record' }] },
      { ...input, mutations: Array(10001).fill({}) },
      { ...input, sideEntries: Array(10001).fill({}) },
    ])
      expect(() => verifyIntegrityCommitManifest(bad)).toThrow()
  })
})
