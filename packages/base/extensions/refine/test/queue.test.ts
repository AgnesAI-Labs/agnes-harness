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

  it('keeps only the newest REFINE_TOMBSTONE_MAX tombstones, evicting by insertion order not key order', () => {
    const ns = new MemNamespace()
    const q = new RefineQueue(ns)
    // Key order is the reverse of insertion order: the first-inserted id has the largest key.
    const id = (i: number) => `p${String(REFINE_TOMBSTONE_MAX - i).padStart(4, '0')}`
    for (let i = 0; i <= REFINE_TOMBSTONE_MAX; i++) {
      q.push(p(id(i)))
      q.mark(id(i), i % 2 ? 'rejected' : 'applied')
    }
    expect(REFINE_TOMBSTONE_MAX).toBe(1000)
    expect(ns.entries().filter(({ key }) => key.startsWith('done:'))).toHaveLength(1000)
    // The first-inserted id (largest key) is evicted; the most recently inserted (smallest key) stays.
    expect(ns.get(`done:${id(0)}`)).toBeUndefined()
    expect(ns.get(`done:${id(1)}`)).toBe(2)
    expect(ns.get(`done:${id(REFINE_TOMBSTONE_MAX)}`)).toBe(1001)
    expect(ns.entries().some(({ key }) => key.startsWith('row:'))).toBe(false)
    expect(() => q.push(p(id(1)))).toThrow('duplicate refine proposal')
    q.push(p(id(0)))
    expect(q.next()?.proposalId).toBe(id(0))
    // One more round past the cap: the sequence continues from the max, not from a count.
    q.mark(id(0), 'applied')
    expect(ns.get(`done:${id(0)}`)).toBe(1002)
    expect(ns.get(`done:${id(1)}`)).toBeUndefined()
    expect(ns.entries().filter(({ key }) => key.startsWith('done:'))).toHaveLength(1000)
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
    ns.set('row:x', row('x', 'applied', '2026-01-02T00:00:00.000Z'))
    ns.set('row:y', row('y', 'rejected', '2026-01-01T00:00:00.000Z'))
    ns.set('row:z', row('z', 'queued', '2026-01-03T00:00:00.000Z'))
    const q = new RefineQueue(ns)
    expect(ns.get('row:x')).toBeUndefined()
    expect(ns.get('row:y')).toBeUndefined()
    // created_at order, not key order: y is older than x.
    expect([ns.get('done:x'), ns.get('done:y')]).toEqual([2, 1])
    expect(q.next()?.proposalId).toBe('z')
    expect(q.queuedCount()).toBe(1)
  })
})
