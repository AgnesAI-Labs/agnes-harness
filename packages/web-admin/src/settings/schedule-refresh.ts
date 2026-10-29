import { useEffect, useRef } from 'react'
import type { ScheduleActivity, ScheduleRow } from './schedule-model.js'

export const SCHEDULE_ACTIVE_REFRESH_MS = 5_000

/** Only work that can change by itself needs repeated reads. */
export function schedulesActive(rows: readonly ScheduleRow[], now: number): boolean {
  return rows.some((row) => {
    const last = row.runs.at(-1)?.outcome
    return (
      last === 'running' ||
      last === 'waiting_approval' ||
      last === 'needs_attention' ||
      (row.status === 'active' && row.nextRunAt !== null && row.nextRunAt <= now)
    )
  })
}

/** Idle lists rest until a due time, visibility/reconnect, or an explicit action. */
export function useScheduleRefresh(
  refresh: () => Promise<void>,
  rows: readonly ScheduleRow[],
  enabled: boolean,
  activity?: ScheduleActivity,
): { expectRun(): void } {
  const latest = useRef({ refresh, rows, activity })
  latest.current = { refresh, rows, activity }
  const expected = useRef(0)
  const reschedule = useRef<() => void>(() => undefined)
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let alive = true
    let attempts = 0
    const schedule = () => {
      clearTimeout(timer)
      if (!alive || inFlight || document.visibilityState === 'hidden') return
      const now = Date.now()
      const activity = latest.current.activity
      if (
        activity?.hasOpenRuns ||
        (activity?.nextRunAt != null && activity.nextRunAt <= now) ||
        schedulesActive(latest.current.rows, now) ||
        now < expected.current
      ) {
        timer = setTimeout(tick, Math.min(30_000, SCHEDULE_ACTIVE_REFRESH_MS * 2 ** attempts))
      } else {
        attempts = 0
        // A single wake at the next due time also handles tasks more than a minute away.
        const due = latest.current.rows.flatMap((row) =>
          row.status === 'active' && row.nextRunAt !== null && row.nextRunAt > now ? [row.nextRunAt] : [],
        )
        if (activity?.nextRunAt != null && activity.nextRunAt > now) due.push(activity.nextRunAt)
        if (due.length) timer = setTimeout(tick, Math.min(2_147_483_647, Math.min(...due) - now))
      }
    }
    const tick = () => {
      if (!alive || inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      void latest.current
        .refresh()
        .catch(() => undefined)
        .finally(() => {
          inFlight = false
          attempts = Math.min(3, attempts + 1)
          if (alive) schedule()
        })
    }
    const wake = () => {
      clearTimeout(timer)
      if (document.visibilityState !== 'hidden') tick()
    }
    reschedule.current = schedule
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('focus', wake)
    schedule()
    return () => {
      alive = false
      clearTimeout(timer)
      reschedule.current = () => undefined
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      window.removeEventListener('focus', wake)
    }
  }, [enabled])
  // biome-ignore lint/correctness/useExhaustiveDependencies: new rows change the next due time.
  useEffect(() => reschedule.current(), [rows, activity])
  return {
    expectRun() {
      expected.current = Date.now() + 2 * 60_000
      reschedule.current()
    },
  }
}
