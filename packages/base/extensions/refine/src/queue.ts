import type { RefineProposal } from '@agnes/core'
import type { PersistenceMetadataNamespace } from '@agnes/extension-api'

// The four real HarnessEntry kinds (core/src/reduce/shapes.ts:46-55) - the closed set an edit's
// `kind` must belong to for the harness seam to accept a proposal.
export const KINDS = new Set(['prompt', 'memory', 'skill', 'subagent'])

type Row = { proposal_id: string; trigger: string; proposal_json: string; status: string; created_at: string }

/**
 * The bounded, durable holding area a `HarnessSeam.propose` call writes into and the production
 * Refine Operation drains. `trigger` is stored as whatever string the real
 * `RefineProposal.trigger` union carries at the time - including 'rollback', which core's own
 * `rollbackRefine` constructs to invert an earlier applied refine - so this queue (and the seam
 * built on it) never narrows that union to fewer than its real four values. Each proposal is one
 * `row:<proposalId>` entry in the owner's metadata namespace.
 */
export class RefineQueue {
  constructor(private readonly ns: PersistenceMetadataNamespace) {}

  queuedCount(): number {
    return this.ns
      .entries()
      .filter(({ key, value }) => key.startsWith('row:') && (value as Row).status === 'queued').length
  }

  push(p: RefineProposal): void {
    const ns = this.ns
    ns.transaction(() => {
      if (ns.get(`row:${p.proposalId}`) !== undefined) throw new Error('duplicate refine proposal')
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

  mark(id: string, status: 'applied' | 'rejected'): void {
    const ns = this.ns
    ns.transaction(() => {
      const row = ns.get(`row:${id}`) as Row | undefined
      if (row) ns.set(`row:${id}`, { ...row, status })
    })
  }
}
