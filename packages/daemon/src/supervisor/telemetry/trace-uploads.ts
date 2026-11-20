import { homedir } from 'node:os'
import type { TableHandle } from '@agnes/daemon-foundation/storage/table'
import type { ConfigurationService, ScanRead } from '@agnes/host'
import type { ConfigAccount, EventEnvelope } from '@agnes/protocol'
import { telemetryAccounts } from './routes.js'
import { type QueuedTrace, type TraceSession, traceWatermarks, uploadTrace } from './traces.js'
import type { Surface, telemetryRuntime } from './wire.js'

type Workspace = Pick<TraceSession, 'cwd' | 'extraRoots'>
type PendingTrace = Pick<TraceSession, 'key' | 'seq' | 'surface'> & {
  workspace?: () => Workspace
  /** Consecutive failed uploads of this session. */
  attempts: number
  /** Earliest time its next upload may start. */
  due: number
}
type Outcome = Awaited<ReturnType<typeof uploadTrace>>

export const MAX_PENDING = 1024
// Retries double from the base delay up to 64 times it. After the last attempt the work waits in
// the durable queue for the session's next boundary or the next daemon start, never in a loop.
const MAX_ATTEMPTS = 8
// A daemon start resumes this many unfinished sessions, newest first; the rest wait for later starts.
const RECOVERY_LIMIT = 16

export type TraceUploadOptions = {
  home: string
  endpoint: URL | undefined
  installId: string | undefined
  clock: () => number
  runtime: ReturnType<typeof telemetryRuntime>
  lifecycle: AbortSignal
  debounce: number
  retry: number
  configuration?: Pick<ConfigurationService, 'get'> | undefined
  scan?: ((key: string) => ScanRead<EventEnvelope>) | undefined
  table?: (() => TableHandle) | undefined
  paths?: ((cwd?: string) => { privatePaths: string[]; workspacePaths: string[] }) | undefined
  credentials?: (() => readonly string[] | Promise<readonly string[]>) | undefined
}

/**
 * Session Log delivery. Each enablement of the switch opens a window that starts at its own time:
 * rows committed before it, including while the switch or the environment kept upload off, are
 * never sent. Unacknowledged work is retried with backoff and kept in a durable queue that the
 * next daemon start resumes.
 */
export function traceUploads(o: TraceUploadOptions) {
  const { endpoint, installId, scan, table, clock } = o
  const pending = new Map<string, PendingTrace>()
  let watermarks: ReturnType<typeof traceWatermarks> | undefined
  let since: number | undefined
  let recover = false
  let cancellation = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let run: Promise<void> | undefined
  let closing = false
  const usable =
    endpoint !== undefined && installId !== undefined && scan !== undefined && table !== undefined
  const store = () => {
    if (!table) throw new Error('Session Log storage is unavailable')
    watermarks ??= traceWatermarks(table())
    return watermarks
  }

  /** A storage failure stays inside telemetry: the in-memory queue still delivers this run's work. */
  function durably(write: (marks: ReturnType<typeof traceWatermarks>) => void): void {
    try {
      write(store())
    } catch {
      // The next boundary writes the queue again.
    }
  }

  function schedule(): void {
    clearTimeout(timer)
    timer = undefined
    if (run || closing || since === undefined || (!pending.size && !recover)) return
    let next = recover ? clock() + o.debounce : Number.POSITIVE_INFINITY
    for (const item of pending.values()) next = Math.min(next, item.due)
    timer = setTimeout(
      () => {
        timer = undefined
        uploads()
      },
      Math.max(1, Math.min(next - clock(), 2 ** 31 - 1)),
    )
    timer.unref()
  }

  function adopt(entry: QueuedTrace): void {
    if (pending.has(entry.key) || pending.size >= MAX_PENDING) return
    const { key, seq, surface, workspace } = entry
    pending.set(key, { key, seq, surface, workspace: () => workspace, attempts: 0, due: clock() })
  }

  function settle(key: string, seq: number, outcome: Outcome, enabledSince: number): void {
    const item = pending.get(key)
    if (!item || since !== enabledSince) return
    if (outcome === 'done' && item.seq <= seq) {
      pending.delete(key)
      // Whatever is left (an unfinished turn, a memory session) cannot be sent; a later boundary
      // queues the session again instead of a stale entry taking a slot at every start.
      durably((marks) => marks.dequeue(key, seq))
      return
    }
    // A boundary observed during a finished upload stays queued under its original debounce.
    if (outcome === 'done') item.attempts = 0
    else if (++item.attempts >= MAX_ATTEMPTS) pending.delete(key)
    else item.due = clock() + o.retry * 2 ** Math.min(item.attempts - 1, 6)
    // After an earlier enablement's entry is acknowledged, this enablement's work becomes durable.
    durably((marks) => {
      if (item.seq > marks.read(key))
        marks.queue(
          {
            key,
            seq: item.seq,
            since: enabledSince,
            surface: item.surface,
            workspace: item.workspace?.() ?? {},
          },
          new Date(clock()).toISOString(),
        )
    })
  }

  async function upload(
    item: PendingTrace,
    seq: number,
    enabledSince: number,
    shared: { accounts: readonly ConfigAccount[]; credentialValues: readonly string[]; signal: AbortSignal },
  ): Promise<Outcome> {
    if (!scan || !endpoint || !installId) return 'done'
    const session = { key: item.key, seq, surface: item.surface, ...item.workspace?.() }
    const { privatePaths = [], workspacePaths = [] } = o.paths?.(session.cwd) ?? {}
    return uploadTrace({
      ...shared,
      session,
      since: enabledSince,
      scan: scan(item.key),
      watermarks: store(),
      installId,
      endpoint,
      clock,
      runtime: o.runtime,
      privatePaths: [o.home, ...privatePaths, homedir()],
      workspacePaths: [
        ...workspacePaths,
        ...(session.cwd ? [session.cwd] : []),
        ...(session.extraRoots ?? []),
      ],
    })
  }

  function uploads(flush = false): void {
    if (run || since === undefined || !usable) return
    const enabledSince = since
    if (recover) {
      recover = false
      durably((marks) => {
        for (const entry of marks.outstanding(RECOVERY_LIMIT)) adopt(entry)
      })
    }
    const now = clock()
    // A flush at shutdown sends debounced work but leaves backed-off retries to their schedule.
    const due = [...pending.values()]
      .filter((item) => item.due <= now || (flush && item.attempts === 0))
      .map(({ key, seq }) => ({ key, seq }))
    if (!due.length) {
      schedule()
      return
    }
    const signal = AbortSignal.any([o.lifecycle, cancellation.signal])
    run = (async () => {
      const accounts = await telemetryAccounts(o.configuration)
      signal.throwIfAborted()
      const credentialValues = (await o.credentials?.()) ?? []
      for (const { key, seq } of due) {
        signal.throwIfAborted()
        const item = pending.get(key)
        if (!item) continue
        const outcome = await upload(item, seq, enabledSince, { accounts, credentialValues, signal }).catch(
          () => 'failed' as const,
        )
        settle(key, seq, outcome, enabledSince)
      }
    })()
      .catch(() => {
        // Accounts or credentials were unreadable, so nothing could be redacted: retry the batch.
        if (!signal.aborted) for (const { key, seq } of due) settle(key, seq, 'failed', enabledSince)
      })
      .finally(() => {
        run = undefined
        schedule()
      })
  }

  return {
    /** Open a new upload window; `resume` also retries what earlier daemon runs left unacknowledged. */
    enable(resume = false): void {
      if (!usable || since !== undefined) return
      since = clock()
      recover = resume
      schedule()
    },
    disable(): void {
      if (!usable) return
      since = undefined
      recover = false
      clearTimeout(timer)
      timer = undefined
      pending.clear()
      cancellation.abort()
      cancellation = new AbortController()
      // Off cancels unfinished uploads for good; the next enablement opens its own window.
      durably((marks) => marks.clearQueue())
    },
    observe(key: string, seq: number, surface: Surface, workspace?: () => Workspace): void {
      if (since === undefined || closing || !usable) return
      const enabledSince = since
      const queued = { key, seq, since: enabledSince, surface, workspace: workspace?.() ?? {} }
      durably((marks) => marks.queue(queued, new Date(clock()).toISOString()))
      const previous = pending.get(key)
      if (previous) {
        if (seq <= previous.seq) return
        Object.assign(previous, { seq, surface }, workspace ? { workspace } : {})
      } else if (pending.size < MAX_PENDING)
        pending.set(key, {
          key,
          seq,
          surface,
          ...(workspace ? { workspace } : {}),
          attempts: 0,
          due: clock() + o.debounce,
        })
      schedule()
    },
    active: () => run,
    flush: () => uploads(true),
    close(): void {
      closing = true
      clearTimeout(timer)
      timer = undefined
    },
    clear(): void {
      pending.clear()
    },
  }
}
