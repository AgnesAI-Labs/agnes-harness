import type { TableHandle } from '../../../src/seam-init.js'

// `id` is unused for lookups today (record()/projected() both key off effect_id and model), but a
// PRIMARY KEY column is what gives sqlite's own storage a stable rowid to fall back on, and it costs
// nothing to declare. `effect_id` carries the real uniqueness this table exists to enforce: the same
// effect replayed by a resumed session must land one row, not one per replay.
const DDL =
  'CREATE TABLE IF NOT EXISTS usage_ledger (' +
  'id INTEGER PRIMARY KEY, ' +
  'session_key TEXT NOT NULL, ' +
  'lane TEXT NOT NULL, ' +
  'turn INTEGER NOT NULL, ' +
  'step INTEGER NOT NULL, ' +
  'purpose TEXT NOT NULL, ' +
  'effect_id TEXT NOT NULL UNIQUE, ' +
  'model TEXT NOT NULL, ' +
  'tokens_input INTEGER NOT NULL, ' +
  'tokens_output INTEGER NOT NULL, ' +
  'tokens_cache_read INTEGER NOT NULL, ' +
  'tokens_cache_write INTEGER NOT NULL, ' +
  'credits REAL, ' +
  'credit_source TEXT NOT NULL, ' +
  'timing_json TEXT, ' +
  'interrupted INTEGER NOT NULL DEFAULT 0, ' +
  'adjustment INTEGER NOT NULL DEFAULT 0, ' +
  'recorded_at TEXT NOT NULL' +
  ')'

/** Opens (creating on first use) the one table this seam owns, indexed for `projected`'s per-model scan. */
export function openLedger(t: TableHandle): TableHandle {
  t.exec(DDL)
  t.exec('CREATE INDEX IF NOT EXISTS usage_ledger_model ON usage_ledger (model, id)')
  return t
}
