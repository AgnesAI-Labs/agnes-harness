import type { RefineProposal } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { MemNamespace } from '../../../testkit/seam-init.js'
import { REFINE_TOMBSTONE_MAX, RefineQueue } from '../src/queue.js'

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

describe('refine queue tombstones', () => {
  it('replaces a terminal row with an id-only tombstone and still refuses the reused id', () => {
    const ns = new MemNamespace()
    const q = new RefineQueue(ns)
    q.push(p('a'))
    q.mark('a', 'applied')
    expect(ns.get('row:a')).toBeUndefined()
    expect(ns.get('done:a')).toBe(1)
    expect(() => q.push(p('a'))).toThrow('duplicate refine proposal')
    expect(q.next()).toBeUndefined()
    expect(q.queuedCount()).toBe(0)
  })

  it('keeps only the newest REFINE_TOMBSTONE_MAX tombstones', () => {
    const ns = new MemNamespace()
    const q = new RefineQueue(ns)
    const id = (i: number) => `p${String(i).padStart(4, '0')}`
    for (let i = 0; i <= REFINE_TOMBSTONE_MAX; i++) {
      q.push(p(id(i)))
      q.mark(id(i), i % 2 ? 'rejected' : 'applied')
    }
    expect(REFINE_TOMBSTONE_MAX).toBe(1000)
    expect(ns.entries().filter(({ key }) => key.startsWith('done:'))).toHaveLength(1000)
    expect(ns.get('done:p0000')).toBeUndefined()
    expect(ns.get('done:p0001')).toBe(2)
    expect(ns.entries().some(({ key }) => key.startsWith('row:'))).toBe(false)
    expect(() => q.push(p('p0001'))).toThrow('duplicate refine proposal')
    q.push(p('p0000'))
    expect(q.next()?.proposalId).toBe('p0000')
  })

  it('converts terminal rows left by an earlier build into tombstones on construction', () => {
    const ns = new MemNamespace()
    const row = (id: string, status: string, at: string) => ({
      proposal_id: id,
      trigger: 'auto',
      proposal_json: JSON.stringify(p(id)),
      status,
      created_at: at,
    })
    ns.set('row:x', row('x', 'applied', '2026-01-01T00:00:00.000Z'))
    ns.set('row:y', row('y', 'rejected', '2026-01-02T00:00:00.000Z'))
    ns.set('row:z', row('z', 'queued', '2026-01-03T00:00:00.000Z'))
    const q = new RefineQueue(ns)
    expect(ns.get('row:x')).toBeUndefined()
    expect(ns.get('row:y')).toBeUndefined()
    expect([ns.get('done:x'), ns.get('done:y')]).toEqual([1, 2])
    expect(q.next()?.proposalId).toBe('z')
    expect(q.queuedCount()).toBe(1)
  })
})
