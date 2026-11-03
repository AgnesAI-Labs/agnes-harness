import { realpathSync } from 'node:fs'
import { type IdleChildRetirementResult, type Kernel, retireIdleChildren } from '@agnes/core'
import type { AuditSink } from '@agnes/host-infrastructure/audit'
import type { SessionWorkspaceRuntimeTable } from '@agnes/host-infrastructure/session-workspace-runtime'

type RetirementInput = Omit<Parameters<typeof retireIdleChildren>[1], 'canRetireSession'>
type RuntimeOwner = Pick<SessionWorkspaceRuntimeTable, 'retirementStatus'>
const owners = new Map<string, Set<RuntimeOwner>>()

/** Role children live in a different concrete Host, under the same durable deployment. */
export function registerRetirementOwner(dataDir: string, owner: RuntimeOwner) {
  const root = realpathSync(dataDir)
  const tables = owners.get(root) ?? new Set<RuntimeOwner>()
  owners.set(root, tables)
  tables.add(owner)
  let closed = false
  return {
    canRetireSession(key: string): boolean {
      let idle = 0
      for (const table of tables) {
        const state = table.retirementStatus(key)
        if (state === 'busy') return false
        if (state === 'idle') idle++
      }
      return idle === 1
    },
    close() {
      if (closed) return
      closed = true
      tables.delete(owner)
      if (tables.size === 0 && owners.get(root) === tables) owners.delete(root)
    },
  }
}

export function idleChildRetireMs(limits: Readonly<Record<string, unknown>>): number {
  const value = limits['subagent.idle_retire_ms']
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 3_600_000
}

/** One lifecycle-owned timer; a slow sweep keeps later ticks from overlapping it. */
export function scheduleIdleChildMaintenance(options: {
  idleMs: number
  clock: () => number
  run(input: RetirementInput): Promise<IdleChildRetirementResult[]>
  audit: AuditSink
}): { close(): Promise<void> } {
  const abort = new AbortController()
  let running: Promise<void> | undefined
  const report = (failure: { childKey?: string; error: string }) => {
    try {
      options.audit.write({ kind: 'session.child_retirement_failed', detail: failure })
    } catch {
      /* A diagnostic sink cannot stop maintenance. */
    }
  }
  const tick = () => {
    if (abort.signal.aborted || running) return
    running = Promise.resolve()
      .then(() =>
        options.run({ now: options.clock(), idleMs: options.idleMs, limit: 50, signal: abort.signal }),
      )
      .then((results) => {
        for (const result of results)
          if (result.status === 'failed')
            report({ childKey: result.childKey, error: result.error ?? 'retirement-failed' })
      })
      .catch(() => report({ error: 'retirement-sweep-failed' }))
      .finally(() => {
        running = undefined
      })
  }
  const timer = options.idleMs > 0 ? setInterval(tick, 60_000) : undefined
  timer?.unref()
  return {
    close() {
      abort.abort()
      if (timer) clearInterval(timer)
      return running ?? Promise.resolve()
    },
  }
}

export function startIdleChildMaintenance(options: {
  kernel: Kernel
  workspaces: RuntimeOwner
  dataDir: string
  limits: Readonly<Record<string, unknown>>
  audit: AuditSink
}): { close(): Promise<void> } {
  const ownership = registerRetirementOwner(options.dataDir, options.workspaces)
  const scheduler = scheduleIdleChildMaintenance({
    idleMs: idleChildRetireMs(options.limits),
    clock: options.kernel.clock,
    run: (input) =>
      retireIdleChildren(options.kernel, { ...input, canRetireSession: ownership.canRetireSession }),
    audit: options.audit,
  })
  return { close: () => scheduler.close().finally(() => ownership.close()) }
}
