import type { RefineProposal } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { fakeSeamInit } from '../../../testkit/seam-init.js'
import { RefineQueue } from '../src/queue.js'
import { refineHarness } from '../src/seam.js'

const p = (id: string, kind = 'memory'): RefineProposal =>
  ({
    proposalId: id,
    trigger: 'auto',
    edits: [
      {
        op: 'upsert',
        entry: { kind, id: 'm1', title: 't', content: 'c', scope: 'local', version: 0 } as never,
      },
    ],
    baseline: [],
    rationale: 'r',
    evidenceSeqs: [3],
  }) as RefineProposal

describe('refine harness', () => {
  it('queues valid proposals and rejects bad kinds or a full queue', async () => {
    const init = fakeSeamInit({ preset: { harness: { queue_max: 2 } } })
    const h = await refineHarness(init)
    expect(await h.propose(p('a'))).toBe('queued')
    expect(await h.propose(p('b', 'bogus'))).toBe('rejected')
    expect(await h.propose(p('c'))).toBe('queued')
    expect(await h.propose(p('d'))).toBe('rejected')
    const q = new RefineQueue(init.adapters.storage.table('refine_queue'))
    expect(q.next()?.proposalId).toBe('a')
    q.mark('a', 'applied')
    expect(q.next()?.proposalId).toBe('c')
  })

  // Real HarnessSeam.propose (core/src/effects/seams.ts:137-150) takes a RefineProposal whose
  // `trigger` union has a fourth member, 'rollback', plus an optional `rollbackOf` - both already
  // shipped by core's own rollbackRefine (core/src/refine/apply.ts). Nothing in refineHarness may
  // narrow `trigger` to the plan's stale three-value description in a way that rejects this.
  it('accepts a rollback-triggered proposal (core-constructed, not narrowed to three trigger values)', async () => {
    const init = fakeSeamInit({ preset: { harness: { queue_max: 5 } } })
    const h = await refineHarness(init)
    const rollback: RefineProposal = {
      proposalId: 'rb-1',
      trigger: 'rollback',
      rollbackOf: 7,
      // 'delete' (not 'remove' - see propose-tool.ts's doc comment on the same correction) needs no
      // HarnessEntry at all, which conveniently keeps this case independent of the `source` design
      // call made in propose-tool.ts.
      edits: [{ op: 'delete', kind: 'memory', id: 'm1' }],
      baseline: [],
      rationale: 'undo m1',
      evidenceSeqs: [7],
    }
    expect(await h.propose(rollback)).toBe('queued')
  })

  it('rejects a delete edit naming a kind outside the four real HarnessEntry kinds', async () => {
    const init = fakeSeamInit({ preset: { harness: { queue_max: 5 } } })
    const h = await refineHarness(init)
    const bad: RefineProposal = {
      proposalId: 'd-bad',
      trigger: 'manual',
      edits: [{ op: 'delete', kind: 'bogus' as never, id: 'm1' }],
      baseline: [],
      rationale: 'r',
      evidenceSeqs: [1],
    }
    expect(await h.propose(bad)).toBe('rejected')
  })
})
