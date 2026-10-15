import { useEffect, useRef } from 'react'
import type { ScheduleRow } from './schedule-model.js'

/** How often a visible list re-reads while something is happening, and while nothing is. */
export const SCHEDULE_ACTIVE_REFRESH_MS = 5_000
export const SCHEDULE_IDLE_REFRESH_MS = 30_000
/** A run due this soon counts as happening, so its start shows without a manual reload. */
const DUE_SOON_MS = 60_000

/**
 * Something on the list will change by itself: a run in progress or waiting for approval, or an
 * active task due within a minute.
 */
export function schedulesActive(rows: readonly ScheduleRow[], now: number): boolean {
  return rows.some((row) => {
    const last = row.runs.at(-1)?.outcome
    return (
      last === 'running' ||
      last === 'waiting_approval' ||
      (row.status === 'active' && row.nextRunAt !== null && row.nextRunAt - now < DUE_SOON_MS)
    )
  })
}

/**
 * Keeps the automation list current while it is on screen: a bounded poll (quick while a run is
 * happening or was just asked for, slow otherwise), paused while the page is hidden, and an
 * immediate read when it becomes visible again or the connection comes back.
 */
export function useScheduleRefresh(
  refresh: () => Promise<void>,
  rows: readonly ScheduleRow[],
  enabled: boolean,
): { expectRun(): void } {
  const latest = useRef(refresh)
  latest.current = refresh
  // A «run now» shows its start quickly even before the list reports it as running.
  const expected = useRef(0)
  const reschedule = useRef<() => void>(() => undefined)
  const quick = schedulesActive(rows, Date.now())
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    // This effect's lifetime. Cleanup ends it, so a read still open then (on unmount, or when the
    // pace changes and a new chain takes over) can neither read again nor schedule the next poll.
    let alive = true
    const tick = () => {
      if (!alive) return
      if (document.visibilityState === 'hidden' || inFlight) return schedule()
      inFlight = true
      void latest
        .current()
        .catch(() => undefined)
        .finally(() => {
          inFlight = false
          if (alive) schedule()
        })
    }
    const schedule = () => {
      clearTimeout(timer)
      if (!alive) return
      const fast = quick || Date.now() < expected.current
      timer = setTimeout(tick, fast ? SCHEDULE_ACTIVE_REFRESH_MS : SCHEDULE_IDLE_REFRESH_MS)
    }
    const wake = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer)
        tick()
      }
    }
    reschedule.current = schedule
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    schedule()
    return () => {
      alive = false
      clearTimeout(timer)
      reschedule.current = () => undefined
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
    }
  }, [enabled, quick])
  return {
    expectRun() {
      expected.current = Date.now() + 2 * 60_000
      reschedule.current()
    },
  }
}
