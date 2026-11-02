import type { RefineProposal } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { createRefineHarness } from '../src/seam.js'

const proposal: RefineProposal = {
  proposalId: 'a',
  trigger: 'auto',
  edits: [
    {
      op: 'upsert',
      entry: {
        kind: 'memory',
        id: 'm1',
        title: 't',
        content: 'c',
        scope: 'local',
        version: 0,
        source: 'harness_propose',
      } as never,
    },
  ],
  baseline: [],
  rationale: 'r',
  evidenceSeqs: [3],
}

describe('refine harness', () => {
  // Nothing drains a proposal any more, so the intake holds none: a valid proposal is refused
  // rather than reported queued and then never applied.
  it('refuses every proposal and keeps nothing', async () => {
    const h = createRefineHarness()
    expect(await h.propose(proposal)).toBe('rejected')
    expect(await h.propose({ ...proposal, trigger: 'rollback', rollbackOf: 7 })).toBe('rejected')
    expect(await h.propose({ ...proposal, edits: [{ op: 'delete', kind: 'memory', id: 'm1' }] })).toBe(
      'rejected',
    )
  })
})
