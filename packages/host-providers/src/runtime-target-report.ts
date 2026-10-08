import type {
  RuntimeConvergenceReport,
  RuntimeConvergenceRow,
  RuntimeTarget,
} from '@agnes/plugin-runtime/host'
import { RESOURCE_OWNED_ROW_IDS } from '@agnes/plugin-runtime/host'

/**
 * Build the one report for a successfully prepared runtime candidate. Resource-owned rows never
 * enter the ordinary tree, but are still reported exactly once from their dedicated slots.
 */
export function buildRuntimeTargetConvergenceReport(
  target: RuntimeTarget,
  ordinaryState: (id: string) => RuntimeConvergenceRow['state'] = () => 'active',
  /** Why a row is not active, for the rows that are not: a report that only says `pending` hides it. */
  ordinaryReason: (id: string) => string | undefined = () => undefined,
): RuntimeConvergenceReport {
  const rows: RuntimeConvergenceRow[] = target.tree.rows.map((row) => {
    const state = row.disabled ? 'disabled' : ordinaryState(row.id)
    const reason = state === 'active' || state === 'disabled' ? undefined : ordinaryReason(row.id)
    return Object.freeze({ id: row.id, state, ...(reason === undefined ? {} : { reason }) })
  })
  for (const id of RESOURCE_OWNED_ROW_IDS) {
    const row = target.resource.rows[id]
    rows.push(
      Object.freeze({
        id,
        state: !row || row.disabled ? 'disabled' : 'active',
      }),
    )
  }
  rows.sort((left, right) => left.id.localeCompare(right.id))
  return Object.freeze({
    hash: target.tree.hash,
    ok: rows.every((row) => row.state === 'active' || row.state === 'disabled'),
    rows: Object.freeze(rows),
  })
}
