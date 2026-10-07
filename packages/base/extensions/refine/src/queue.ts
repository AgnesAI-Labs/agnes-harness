import type { RefineProposal } from '@agnes/core'
import type { PersistenceMetadataNamespace } from '@agnes/extension-api'
import type { TableHandle } from '../../../src/seam-init.js'

// The four real HarnessEntry kinds (core/src/reduce/shapes.ts:46-55) - the closed set an edit's
// `kind` must belong to for the harness seam to accept a proposal.
export const KINDS = new Set(['prompt', 'memory', 'skill', 'subagent'])

type Row = { proposal_id: string; trigger: string; proposal_json: string; status: string; created_at: string }

/**
 * The bounded, durable holding area a `HarnessSeam.propose` call writes into and the production
 * Refine Operation drains. `trigger` is stored as whatever string the real
 * `RefineProposal.trigger` union carries at the time - including 'rollback', which core's own
 * `rollbackRefine` constructs to invert an earlier applied refine - so this table (and the seam
 * built on it) never narrows that union to fewer than its real four values.
 */
export class RefineQueue {
  constructor(private readonly t: TableHandle | PersistenceMetadataNamespace) {
    if ('exec' in t)
      t.exec(
        'CREATE TABLE IF NOT EXISTS refine_queue (proposal_id TEXT PRIMARY KEY, trigger TEXT NOT NULL, proposal_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)',
      )
  }

  queuedCount(): number {
    // AS count is required, not cosmetic: an unaliased aggregate's column name is the expression as
    // written ('COUNT(*)', literally - see testkit/mem-table.ts's doc comment, measured against
    // node:sqlite), so `.count` on an unaliased row is always undefined and this would silently
    // always read 0, defeating queue_max entirely. The plan's own Step 3 sample omitted the alias.
    if (!('exec' in this.t))
      return this.t
        .entries()
        .filter(({ key, value }) => key !== 'migration' && (value as Row).status === 'queued').length
    return (
      this.t.get<{ count: number }>('SELECT COUNT(*) AS count FROM refine_queue WHERE status = ?', ['queued'])
        ?.count ?? 0
    )
  }

  push(p: RefineProposal): void {
    if (!('exec' in this.t)) {
      const ns = this.t
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
      return
    }
    this.t.run(
      'INSERT INTO refine_queue (proposal_id, trigger, proposal_json, status, created_at) VALUES (?, ?, ?, ?, ?)',
      [p.proposalId, p.trigger, JSON.stringify(p), 'queued', new Date().toISOString()],
    )
  }

  next(): RefineProposal | undefined {
    const r = !('exec' in this.t)
      ? this.t
          .entries()
          .filter(({ key }) => key !== 'migration')
          .map(({ value }) => value as Row)
          .filter((r) => r.status === 'queued')
          .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
      : this.t.get<Row>('SELECT * FROM refine_queue WHERE status = ? ORDER BY created_at LIMIT 1', ['queued'])
    return r ? (JSON.parse(r.proposal_json) as RefineProposal) : undefined
  }

  mark(id: string, status: 'applied' | 'rejected'): void {
    if (!('exec' in this.t)) {
      const ns = this.t
      ns.transaction(() => {
        const row = ns.get(`row:${id}`) as Row | undefined
        if (row) ns.set(`row:${id}`, { ...row, status })
      })
      return
    }
    this.t.run('UPDATE refine_queue SET status = ? WHERE proposal_id = ?', [status, id])
  }
}
