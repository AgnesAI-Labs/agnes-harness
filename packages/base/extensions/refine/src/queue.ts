import type { RefineProposal } from '@agnes/core'
import type { PersistenceMetadataNamespace } from '@agnes/extension-api'

// The four real HarnessEntry kinds (core/src/reduce/shapes.ts:46-55) - the closed set an edit's
// `kind` must belong to for the harness seam to accept a proposal.
export const KINDS = new Set(['prompt', 'memory', 'skill', 'subagent'])

type Row = { proposal_id: string; trigger: string; proposal_json: string; status: string; created_at: string }

/** How many `done:<proposalId>` tombstones are kept; older ones are dropped, so a very old id can be reused. */
export const REFINE_TOMBSTONE_MAX = 1000

/**
 * The bounded, durable holding area a `HarnessSeam.propose` call writes into and the production
 * Refine Operation drains. `trigger` is stored as whatever string the real
 * `RefineProposal.trigger` union carries at the time - including 'rollback', which core's own
 * `rollbackRefine` constructs to invert an earlier applied refine - so this queue (and the seam
 * built on it) never narrows that union to fewer than its real four values. A queued proposal is
 * one `row:<proposalId>` entry in the owner's metadata namespace. Once marked applied or rejected
 * the row is replaced by a `done:<proposalId>` tombstone holding a strictly increasing sequence
 * number: the id stays refused, but `next()` no longer scans history, and only the newest
 * REFINE_TOMBSTONE_MAX tombstones are kept. Terminal rows written by an earlier build are
 * converted to tombstones on construction.
 */
export class RefineQueue {
  constructor(private readonly ns: PersistenceMetadataNamespace) {
    ns.transaction(() => {
      const terminal = ns
        .entries()
        .filter(({ key, value }) => key.startsWith('row:') && (value as Row).status !== 'queued')
        .sort((a, b) => {
          const ca = (a.value as Row).created_at
          const cb = (b.value as Row).created_at
          return ca < cb ? -1 : ca > cb ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0
        })
      if (terminal.length === 0) return
      // Read the tombstones once, number the converted rows after them, trim once at the end.
      const seqs = this.#tombstones()
      let next = Math.max(0, ...seqs.values()) + 1
      for (const { key } of terminal) {
        const id = key.slice('row:'.length)
        ns.delete(key)
        ns.set(`done:${id}`, next)
        seqs.set(`done:${id}`, next++)
      }
      this.#trim(seqs)
    })
  }

  #tombstones(): Map<string, number> {
    return new Map(
      this.ns
        .entries()
        .filter(({ key }) => key.startsWith('done:'))
        .map(({ key, value }) => [key, value as number]),
    )
  }

  /** Drop the tombstones with the smallest sequence numbers beyond REFINE_TOMBSTONE_MAX. */
  #trim(seqs: Map<string, number>): void {
    const excess = seqs.size - REFINE_TOMBSTONE_MAX
    if (excess <= 0) return
    for (const [key] of [...seqs].sort((a, b) => a[1] - b[1]).slice(0, excess)) this.ns.delete(key)
  }

  /** Replace `row:<id>` with a tombstone and trim the oldest tombstones. Runs inside the caller's transaction. */
  #retire(id: string): void {
    const ns = this.ns
    ns.delete(`row:${id}`)
    const seqs = this.#tombstones()
    const seq = Math.max(0, ...seqs.values()) + 1
    ns.set(`done:${id}`, seq)
    seqs.set(`done:${id}`, seq)
    this.#trim(seqs)
  }

  queuedCount(): number {
    return this.ns
      .entries()
      .filter(({ key, value }) => key.startsWith('row:') && (value as Row).status === 'queued').length
  }

  push(p: RefineProposal): void {
    const ns = this.ns
    ns.transaction(() => {
      if (ns.get(`row:${p.proposalId}`) !== undefined || ns.get(`done:${p.proposalId}`) !== undefined)
        throw new Error('duplicate refine proposal')
      ns.set(`row:${p.proposalId}`, {
        proposal_id: p.proposalId,
        trigger: p.trigger,
        proposal_json: JSON.stringify(p),
        status: 'queued',
        created_at: new Date().toISOString(),
      })
    })
  }

  next(): RefineProposal | undefined {
    const r = this.ns
      .entries()
      .filter(({ key }) => key.startsWith('row:'))
      .map(({ value }) => value as Row)
      .filter((r) => r.status === 'queued')
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
    return r ? (JSON.parse(r.proposal_json) as RefineProposal) : undefined
  }

  /** `status` is not stored: a terminal proposal is only an id-only tombstone. */
  mark(id: string, _status: 'applied' | 'rejected'): void {
    const ns = this.ns
    ns.transaction(() => {
      if (ns.get(`row:${id}`) !== undefined) this.#retire(id)
    })
  }
}
