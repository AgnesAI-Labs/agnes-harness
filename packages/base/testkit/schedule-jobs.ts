import type { ScheduleJobs } from '../extensions/schedule/src/catalog.js'

/** A queued job as the schedule catalog sees it. `payload` and `schedule` are JSON strings, like the SQL row. */
export type MemoryScheduleJob = {
  sessionKey: string
  payload: string
  schedule: string
  status: string
  delayUntil: number
  updatedAt: number
}

const QUEUED = new Set(['waiting', 'delayed'])

/** In-memory jobs for the schedule catalog, answering the same questions as the daemon's jobs table. */
export function memoryScheduleJobs(): ScheduleJobs & { rows: Map<string, MemoryScheduleJob> } {
  const rows = new Map<string, MemoryScheduleJob>()
  const queued = (key: string) => {
    const row = rows.get(key)
    return row && QUEUED.has(row.status) ? row : undefined
  }
  return {
    rows,
    add({ key, sessionKey, prompt, schedule, delayUntil, now }) {
      const payload = JSON.stringify({ prompt })
      const encoded = JSON.stringify(schedule)
      const existing = rows.get(key)
      if (existing) {
        if (
          existing.sessionKey !== sessionKey ||
          existing.payload !== payload ||
          existing.schedule !== encoded
        )
          throw new Error('JOB_IDENTITY_CONFLICT')
        return
      }
      rows.set(key, { sessionKey, payload, schedule: encoded, status: 'waiting', delayUntil, updatedAt: now })
    },
    cancelQueued(key, now) {
      const row = queued(key)
      if (row) Object.assign(row, { status: 'cancelled', updatedAt: now })
    },
    status: (key) => rows.get(key)?.status,
    setPrompt(key, prompt, now) {
      const row = queued(key)
      if (row) Object.assign(row, { payload: JSON.stringify({ prompt }), updatedAt: now })
    },
    runNow(key, now) {
      const row = queued(key)
      if (row) Object.assign(row, { status: 'waiting', delayUntil: now, updatedAt: now })
    },
  }
}
