import type { LedgerSeam } from '@agnes/core'
import type { SeamFactory } from '../../../src/seam-init.js'
import { openLedger } from './ledger-table.js'

type HistRow = {
  credits: number | null
  tokens_input: number
  tokens_output: number
  tokens_cache_read: number
  tokens_cache_write: number
  credit_source: string
}
type Hist = { credits: number; tokens: number; creditSource: string }

/**
 * The `ledger` seam's default implementation: one sqlite-shaped table (`usage_ledger`) recording
 * every billed effect, and a same-model moving average for `projected`'s pre-flight estimate.
 *
 * `record` and `projected` never catch what the table throws - a write failure on the ledger is
 * core's cue to refuse the inference it was about to bill (regulated §4.3.1: a seam that fails is
 * a seam that is absent), so surfacing the table's own error message is the correct behavior, not
 * a gap to paper over.
 */
export const budgetLedger: SeamFactory<LedgerSeam> = async (ctx) => {
  const t = openLedger(ctx.adapters.storage.table('usage_ledger'))
  return {
    async record(r) {
      // Manual check-then-insert rather than `INSERT OR IGNORE`: a resumed session replays the
      // event log and re-runs the effect that produced this row, so the second `record()` for the
      // same `effectId` must be a no-op, not a second row - `effect_id`'s UNIQUE constraint states
      // the intent, but nothing here relies on the underlying engine enforcing it.
      const exists = t.get('SELECT id FROM usage_ledger WHERE effect_id = ?', [r.effectId])
      if (exists) return
      t.run(
        'INSERT INTO usage_ledger (session_key, lane, turn, step, purpose, effect_id, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, credits, credit_source, timing_json, interrupted, adjustment, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          r.sessionKey,
          r.lane,
          r.turn,
          r.step,
          r.purpose,
          r.effectId,
          r.model,
          r.tokens.input,
          r.tokens.output,
          r.tokens.cacheRead,
          r.tokens.cacheWrite,
          r.credits ?? null,
          r.creditSource,
          r.timing ? JSON.stringify(r.timing) : null,
          r.interrupted ? 1 : 0,
          r.adjustment ? 1 : 0,
          new Date().toISOString(),
        ],
      )
    },
    async projected(next) {
      const rows = t.all<HistRow>('SELECT * FROM usage_ledger WHERE model = ? ORDER BY id DESC LIMIT 20', [
        next.model,
      ])
      const hist: Hist[] = rows
        .filter((r) => r.credits !== null)
        .map((r) => ({
          credits: r.credits as number,
          tokens: r.tokens_input + r.tokens_output + r.tokens_cache_read + r.tokens_cache_write,
          creditSource: r.credit_source,
        }))
      // Gateway-billed rows are the ground truth for what a model actually costs; estimated rows
      // are themselves projections, so they are only worth using when nothing better is on hand.
      const gateway = hist.filter((h) => h.creditSource === 'gateway')
      const use = (gateway.length ? gateway : hist).filter((h) => h.tokens > 0)
      if (!use.length) return { credits: 0, creditSource: 'estimated' }
      const perToken = use.reduce((s, h) => s + h.credits, 0) / use.reduce((s, h) => s + h.tokens, 0)
      return { credits: Math.round(perToken * next.tokensEstimate * 100) / 100, creditSource: 'estimated' }
    },
  }
}
