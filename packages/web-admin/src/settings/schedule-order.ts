import { useMemo, useRef } from 'react'
import type { ScheduleRow } from './schedule-model.js'

/** Keep existing tasks under the pointer while their next-run times change. A new query starts fresh. */
export function useScheduleOrder(scope: string | undefined, rows: ScheduleRow[]): ScheduleRow[] {
  const previous = useRef<{ scope: string | undefined; ids: string[] }>()
  return useMemo(() => {
    const byId = new Map(rows.map((row) => [row.id, row]))
    const ids =
      previous.current && previous.current.scope === scope
        ? previous.current.ids.filter((id) => byId.has(id))
        : []
    const known = new Set(ids)
    for (const row of rows) {
      if (!known.has(row.id)) {
        ids.push(row.id)
        known.add(row.id)
      }
    }
    previous.current = { scope, ids }
    return ids.flatMap((id) => {
      const row = byId.get(id)
      return row ? [row] : []
    })
  }, [scope, rows])
}
