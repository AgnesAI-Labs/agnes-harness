import type { ChildAgentListing, ChildAgentStatus, SessionChildJobs, ToolContext } from '@agnes/extension-api'
import type { OutputPosition } from './output-cursor.js'
import type { PersistentShellName } from './persistent-shell.js'

export interface ShellJobView {
  id: string
  owner: 'human' | 'agent'
  ownerSessionId: string
  kind: 'shell' | 'shell-session' | 'pty' | 'child'
  command: string
  cwd: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  code: number | null
  stdout: string
  stderr: string
  truncated: boolean
  stoppedProcesses?: number
  /** The signal that ended the job's own shell when it did not exit by itself. */
  signal?: string
  /** A shell command's own exit code, known before the processes it backgrounded have ended. */
  foregroundCode?: number
  shell?: PersistentShellName
  sessionId?: string
  /** Underlying child-agent status when `kind === 'child'`, preserving states finer than generic job status. */
  childStatus?: ChildAgentStatus
  /** Human-readable task label for a child-agent job when supplied by the child listing. */
  childLabel?: string
}

/** One child pane keeps what a person can still read; the jobs read slices output to the same size. */
export const CHILD_OUTPUT_LIMIT = 65536
export const MAX_DESCENDANT_LIST = 128

export function collectBoundedJobs<J extends { view: ShellJobView }>(
  stores: readonly (Map<string, J> | undefined)[],
  selectedJobId: string | undefined,
  limit: number,
): ShellJobView[] {
  const rows: ShellJobView[] = []
  for (const store of stores) {
    for (const job of store?.values() ?? []) {
      if (rows.length >= limit) break
      rows.push({ ...job.view })
    }
    if (rows.length >= limit) break
  }
  if (selectedJobId && !rows.some((row) => row.id === selectedJobId)) {
    let selected: J | undefined
    for (const store of stores) {
      selected = store?.get(selectedJobId)
      if (selected) break
    }
    if (selected && limit > 0) {
      if (rows.length >= limit) rows[limit - 1] = { ...selected.view }
      else rows.push({ ...selected.view })
    }
  }
  return rows
}

export type ChildJobListing = ChildAgentListing &
  Readonly<{
    ownerSessionId?: string
    direct?: boolean
    readOnly?: boolean
    ambiguous?: boolean
    source?: 'local' | 'external'
  }>

export type ChildCancelTarget = Readonly<{
  providerId?: string
  ownerSessionId?: string
}>

export interface ExtendedChildJobsPort extends SessionChildJobs {
  list(): Promise<readonly ChildJobListing[]>
  readDetail?(id: string): Promise<ChildJobListing | undefined>
  readDirect?(id: string): Promise<ChildJobListing | undefined>
  cancel?(id: string, target?: ChildCancelTarget): Promise<void>
}

export interface ChildJobTarget {
  view: {
    id: string
    ownerSessionId: string
    command: string
    status: 'running' | 'completed' | 'failed' | 'killed'
    code: number | null
    stdout: string
    truncated: boolean
    childStatus?: ChildAgentStatus
    childLabel?: string
  }
  startedAt: number
  cleanupPending?: boolean
  childIdle?: boolean
  childTerminal?: boolean
  readOnly?: boolean
  childText?: string
  position: OutputPosition
  stop(): Promise<void>
  refreshChild?: () => Promise<ChildJobListing | undefined>
  finish(code: number | null): void
}

export function effectiveChildStatus(
  child: Pick<ChildJobListing, 'status' | 'executionState'>,
): ChildAgentStatus {
  if (child.executionState === 'cancelling') return 'running'
  if (
    child.executionState === 'completed' ||
    child.executionState === 'failed' ||
    child.executionState === 'cancelled'
  )
    return child.executionState
  return child.status
}

export function isReadOnlyChildListing(child: ChildJobListing, sessionKey: string): boolean {
  return (
    child.readOnly === true ||
    child.ambiguous === true ||
    child.direct === false ||
    (child.ownerSessionId !== undefined && child.ownerSessionId !== sessionKey)
  )
}

export function resolveChildJobsPort(
  subagent: ToolContext['subagent'] | undefined,
  port: SessionChildJobs | undefined,
  selectedJobId?: string,
): ExtendedChildJobsPort | undefined {
  if (port) return port as ExtendedChildJobsPort
  if (!subagent?.list) return undefined
  return {
    list: async () => {
      const rows = await subagent.list!()
      // Avoid N per-child collect calls during listing (collect also acknowledges results);
      // only read on demand for the explicitly selected child when its listing has no text.
      if (!selectedJobId?.startsWith('child:')) return rows
      const targetId = selectedJobId.slice('child:'.length)
      return Promise.all(
        rows.map(async (child) => {
          if (child.id !== targetId || child.text !== undefined) return child
          const snapshot = await subagent.collect(child.id, { wait: false })
          return { ...child, ...(snapshot.text !== undefined ? { text: snapshot.text } : {}) }
        }),
      )
    },
    cancel: async (id: string) => {
      await subagent.cancel(id)
    },
  }
}

export function upsertChildProjection<J extends ChildJobTarget>(
  sessionKey: string,
  child: ChildJobListing,
  controls: ExtendedChildJobsPort,
  maps: {
    direct: () => Map<string, J>
    descendants: () => Map<string, J>
    create: (id: string, ownerSessionId: string, readOnly: boolean, stop: () => Promise<void>) => J
  },
): J {
  const id = `child:${child.id}`
  const readOnly = isReadOnlyChildListing(child, sessionKey)
  const ownerSessionId = child.ownerSessionId ?? sessionKey
  const targetMap = readOnly ? maps.descendants() : maps.direct()
  const otherMap = readOnly ? maps.direct() : maps.descendants()
  const existingOther = otherMap.get(id)
  if (existingOther) otherMap.delete(id)
  const denyReadOnly = async () => {
    throw new Error('CAPABILITY_DENIED: read-only child job cannot be stopped from this session')
  }
  const cancelDirect = async () => {
    if (!controls.cancel) throw new Error('child cancellation needs an effect service')
    await controls.cancel(child.id, { providerId: child.providerId, ownerSessionId })
  }
  const refreshDirect = async (): Promise<ChildJobListing | undefined> => {
    if (controls.readDirect) {
      const direct = await controls.readDirect(child.id)
      if (direct || !controls.readDetail) return direct
    }
    if (controls.readDetail) return controls.readDetail(child.id)
    return (await controls.list()).find((row) => row.id === child.id)
  }
  let job = targetMap.get(id)
  if (!job) {
    job = maps.create(id, ownerSessionId, readOnly, readOnly ? denyReadOnly : cancelDirect)
    if (existingOther) {
      job.view.stdout = existingOther.view.stdout
      job.view.truncated = existingOther.view.truncated
      job.position = existingOther.position
      if (existingOther.childText !== undefined) job.childText = existingOther.childText
    }
    targetMap.set(id, job)
  } else {
    job.readOnly = readOnly
    job.view.ownerSessionId = ownerSessionId
    job.view.command = child.providerId.slice(0, 2048)
    job.stop = readOnly ? denyReadOnly : controls.cancel ? cancelDirect : job.stop
  }
  if (readOnly) delete job.refreshChild
  else job.refreshChild = refreshDirect
  if (child.label !== undefined) job.view.childLabel = child.label
  if (child.text !== undefined) appendChildText(job, child.text)
  syncChildOutcome(job, effectiveChildStatus(child))
  return job
}

/**
 * Stop a direct child job and reconcile with its authoritative post-stop state.
 * Only transitions to a terminal job outcome (`finish(...)` and completion notice) once the source
 * confirms a durable terminal state (`completed`, `failed`, `cancelled`).
 * Returns `true` when the source no longer reports an entry (reclaimed without a terminal outcome).
 */
export async function stopChildJob(
  job: ChildJobTarget,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  await job.stop()
  job.cleanupPending = false
  if (!job.refreshChild) return false
  let latest: ChildJobListing | undefined
  try {
    latest = await job.refreshChild()
  } catch {
    return false
  }
  if (!isCurrent()) return false
  if (!latest) return true
  if (latest.label !== undefined) job.view.childLabel = latest.label
  if (latest.text !== undefined) appendChildText(job, latest.text)
  syncChildOutcome(job, effectiveChildStatus(latest))
  return false
}

/**
 * Remove active (non-terminal) child projections that are no longer reported by the source, while
 * preserving bounded-list truncation safety and already-terminal history entries.
 */
export async function pruneReclaimedChildren<J extends ChildJobTarget>(
  controls: ExtendedChildJobsPort,
  stores: {
    direct: Map<string, J> | undefined
    descendants: Map<string, J> | undefined
    upsert: (child: ChildJobListing) => J
  },
  sync: {
    present: ReadonlySet<string>
    selectedConfirmedMissing: ReadonlySet<string>
    listedDirect: number
    listedDescendants: number
  },
): Promise<void> {
  const reconcile = async (map: Map<string, J> | undefined, truncated: boolean) => {
    if (!map?.size) return
    for (const [id, job] of [...map]) {
      if (sync.present.has(id) || job.childTerminal) continue
      if (sync.selectedConfirmedMissing.has(id)) {
        if (map.get(id) === job && !job.childTerminal) map.delete(id)
        continue
      }
      if (truncated) continue
      if (controls.readDetail) {
        const detail = await controls.readDetail(id.slice('child:'.length))
        if (detail) {
          stores.upsert(detail)
          continue
        }
      }
      if (map.get(id) === job && !job.childTerminal) map.delete(id)
    }
  }
  await reconcile(stores.direct, sync.listedDirect >= MAX_DESCENDANT_LIST)
  await reconcile(stores.descendants, sync.listedDescendants >= MAX_DESCENDANT_LIST)
}

/**
 * A child agent republishes its newest message: `text` replaces the previous one instead of growing
 * a stream. A pane that only keeps the newest message loses everything said before it, so append the
 * message here — the tail of a message still being written, or a whole new message above it.
 */
export function appendChildText(job: ChildJobTarget, text: string): void {
  if (text === job.childText) return
  let chunk = text
  if (job.childText !== undefined && text.startsWith(job.childText))
    chunk = text.slice(job.childText.length) // Same message, now longer.
  else if (job.view.stdout) chunk = `\n\n${text}` // A new message starts on its own line.
  job.childText = text
  job.view.stdout += chunk
  if (job.view.stdout.length <= CHILD_OUTPUT_LIMIT) return
  const before = Buffer.byteLength(job.view.stdout)
  const tail = job.view.stdout.slice(-CHILD_OUTPUT_LIMIT)
  // Never begin the retained tail with half of a surrogate pair.
  job.view.stdout = /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail
  job.position.stdoutStart += before - Buffer.byteLength(job.view.stdout)
  job.view.truncated = true
}

/**
 * Project a child-agent status onto the unified job lifecycle. Terminal transitions (`completed`,
 * `failed`, `cancelled`) always settle once through `job.finish(...)`, resetting any non-terminal
 * `idle` or `interrupted` projection first so `code`, waiters and completions stay consistent.
 */
export function syncChildOutcome(job: ChildJobTarget, status: ChildAgentStatus): void {
  if (job.childTerminal) return
  job.view.childStatus = status
  if (status === 'idle') {
    // The resident's last turn is done. Keep the job open for its next turn.
    job.childIdle = true
    job.view.status = 'completed'
    job.view.code = 0
    return
  }
  if (status === 'interrupted') {
    // Stopped mid-turn; no longer running, yet continuable on a later turn.
    job.childIdle = true
    job.view.status = 'killed'
    job.view.code = null
    return
  }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    job.childTerminal = true
    job.childIdle = false
    job.view.code = null
    job.view.status = status === 'cancelled' ? 'killed' : 'running'
    job.finish(status === 'completed' ? 0 : -1)
    return
  }
  // Active / attention-needed non-terminal states: starting, running, waiting_approval, paused, disconnected.
  if (job.childIdle) {
    job.childIdle = false
    job.startedAt = Date.now()
  }
  job.view.status = 'running'
  job.view.code = null
}
