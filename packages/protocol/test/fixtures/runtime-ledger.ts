export const runtimeFormatData = {
  formatVersion: 2,
  runtimeSchemaMajor: 1,
  minReader: 1,
  previousFormat: 1,
  legacyThroughSeq: 0,
  sourceHeadDigest: null,
}

export const runtimeCommitData = {
  commitId: 'commit-1',
  transactionFingerprint: 'a'.repeat(64),
  runId: 'run-1',
  actionId: null,
  authorityEpoch: 1,
  writerEpoch: 0,
  previousCommitId: null,
  mutationsDigest: 'b'.repeat(64),
  mutationCount: 3,
  sideListsDigest: 'c'.repeat(64),
  counts: { createdActions: 0, consumedSignals: 0, outboxEvents: 0, receipts: 0, usageOrigins: 0 },
}
