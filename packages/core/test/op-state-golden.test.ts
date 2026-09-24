import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { readGolden, recordTransitions, TRANSITION_SCENARIOS } from '../testkit/record-transitions.js'

// Every commit of every scenario, as recorded from the code that wrote the checked-in recordings.
// A difference here means a transition now commits something else than it did.
describe('program-counter transitions match the recorded reference (MemoryStorage)', () => {
  it('covers every scenario', () => {
    expect(TRANSITION_SCENARIOS.length).toBeGreaterThanOrEqual(10)
  })
  it.each(TRANSITION_SCENARIOS)('%s', async (name) => {
    expect(await recordTransitions(name, new MemoryStorage())).toEqual(readGolden(name))
  })
})
