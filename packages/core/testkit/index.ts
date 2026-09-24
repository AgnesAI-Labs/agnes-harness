// The test doubles host, base and the other packages assemble against. They live here rather than
// inside test/ so a consumer imports them by package path instead of by a relative path into this
// package's test tree.
export { MemoryStorage } from '../src/log/memory-storage.js'
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
export {
  type RecordedCommit,
  readGolden,
  recordTransitions,
  TRANSITION_SCENARIOS,
} from './record-transitions.js'
export { goldenLedger, toolHeavyLedger } from './tool-heavy-ledger.js'
