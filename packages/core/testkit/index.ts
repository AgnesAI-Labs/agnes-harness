// The test doubles host, base and the other packages assemble against. They live here rather than
// inside test/ so a consumer imports them by package path instead of by a relative path into this
// package's test tree.

export { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
export { type EncodedLedgerState, encodeLedgerState } from '@agnes/core-ledger/testkit/encode-ledger-state'
export { deferredResultProvenance } from '../src/execution/turn/deferred.js'
export {
  type FakeProvider,
  fakeProvider,
  type Script,
  sent,
  textTurn,
  toolTurn,
  usage,
} from '../test/helpers/fake-provider.js'
export { fakeSeams } from '../test/helpers/fake-seams.js'
export { actor, noTimers, openSession, readTool, shellTool } from '../test/helpers/open-session.js'
export { fencedFs, testFsPolicy } from './fenced-fs.js'
export { defaultLoops } from './loops.js'
export { OP_CELL_CASES } from './op-cell-cases.js'
export { OP_CHECK_CASES, type Tamperable } from './op-check-cases.js'
export { type SweepResult, type SweepStore, sweepOpenPoints } from './op-check-sweep.js'
export { opMarkProblems } from './op-mark-checks.js'
export {
  CONCURRENT_SCENARIOS,
  callEventProblems,
  expectedFromGolden,
  type GoldenCommit,
  MERGED_STATUSES,
  mergeLedgerWriteCommits,
  type RecordedCommit,
  readGolden,
  recordTransitions,
  renumberSeqs,
  statusProjectionProblems,
  TRANSITION_SCENARIOS,
  withMintedIdsInOrder,
} from './record-transitions.js'
export { goldenLedger, toolHeavyLedger } from './tool-heavy-ledger.js'
