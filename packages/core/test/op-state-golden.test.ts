import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { opMarkProblems } from '../testkit/op-mark-checks.js'
import {
  CONCURRENT_SCENARIOS,
  callEventProblems,
  expectedFromGolden,
  MERGED_STATUSES,
  mergeLedgerWriteCommits,
  readGolden,
  recordTransitions,
  statusProjectionProblems,
  TRANSITION_SCENARIOS,
  withMintedIdsInOrder,
} from '../testkit/record-transitions.js'

// Every commit of every scenario against the reference recorded before the program counter left the
// ledger: the same rows apart from the program-counter row, an op-mark exactly where a transition
// had no row of its own, the counter as a cell at the seq of the commit's last row, the same other
// cells and the same UI summary — with a tool call's adjacent transitions merged into one commit
// the way they are now written. A batch whose calls interleave cannot be merged commit by commit
// (each commit's counter also carries its siblings' states), so it is checked call by call instead.
describe('program-counter transitions match the recorded reference (MemoryStorage)', () => {
  it('covers every scenario', () => {
    expect(TRANSITION_SCENARIOS.length).toBeGreaterThanOrEqual(16)
  })
  it.each(TRANSITION_SCENARIOS)('%s', async (name) => {
    const recorded = await recordTransitions(name, new MemoryStorage())
    const reference = expectedFromGolden(readGolden(name))
    if (CONCURRENT_SCENARIOS.has(name)) {
      expect(statusProjectionProblems(recorded, reference, MERGED_STATUSES)).toEqual([])
      expect(callEventProblems(recorded, reference)).toEqual([])
    } else
      expect(withMintedIdsInOrder(recorded)).toEqual(withMintedIdsInOrder(mergeLedgerWriteCommits(reference)))
    expect(opMarkProblems(recorded)).toEqual([])
  })
})

// With the program counter out of the rows nothing a batch writes grows with its number of calls:
// an op-mark names only the calls that one transition changed.
describe('row width does not grow with the batch', () => {
  const widest = async (name: string) => {
    const widths = new Map<string, number>()
    for (const commit of await recordTransitions(name, new MemoryStorage()))
      for (const row of commit.events as Array<{ type: string; data: unknown }>) {
        // The prompt text differs between the scenarios, not the batch.
        if (row.type === 'inbox' || row.type === 'user/message') continue
        widths.set(row.type, Math.max(widths.get(row.type) ?? 0, JSON.stringify(row.data).length))
      }
    return widths
  }
  it('is the same at four and eight calls as at one', async () => {
    const one = await widest('batch-k1')
    expect(one.get('x/core/op-mark')).toBeGreaterThan(0)
    expect(await widest('batch-k4')).toEqual(one)
    expect(await widest('batch-k8')).toEqual(one)
  })
})
