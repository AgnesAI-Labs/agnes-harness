import { maintenanceTick, type RepairResult } from '@agnes/host'

export const CHILD_MAINTENANCE_INTERVAL_MS = 60_000
export const CHILD_MAINTENANCE_MAX_CANDIDATES = 50
export const CHILD_MAINTENANCE_DEADLINE_MS = 30_000

export type ChildMaintenanceHandle = {
  stop(): void
  runOnce(): RepairResult[]
}

/**
 * Bounded periodic child-resource maintenance. Discovery and auth stay in the daemon; the tick
 * itself talks to Host's SQLite DTO and does not import Core.
 */
export function startChildMaintenance(opts: {
  dbPath: string
  intervalMs?: number
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}): ChildMaintenanceHandle {
  const interval = opts.intervalMs ?? CHILD_MAINTENANCE_INTERVAL_MS
  const setTimeoutFn = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const clearTimeoutFn = opts.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as number))
  let timer: unknown
  let stopped = false
  const runOnce = (): RepairResult[] => maintenanceTick(opts.dbPath)
  const schedule = (): void => {
    if (stopped) return
    timer = setTimeoutFn(() => {
      if (stopped) return
      try {
        runOnce()
      } catch {
        // A single tick failure must not kill the loop.
      }
      schedule()
    }, interval)
  }
  schedule()
  return {
    runOnce,
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeoutFn(timer)
    },
  }
}
