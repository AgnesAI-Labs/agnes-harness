import { join } from 'node:path'
import { type AuditEvent, createFileAudit } from '@agnes/host'

// Injected into the daemon bundle by cli/tools/build-local.ts and sea/build.mjs; absent from source runs.
declare const AGNES_VERSION: string | undefined

/**
 * The daemon runtime log: worker exits, session interruptions, worker log lines and the daemon's
 * own starts, stops and crashes. `audit/daemon.jsonl` beside it is a request audit and records
 * failed requests only, so an empty one says nothing about how the processes fared.
 */
export const RUNTIME_LOG = 'runtime.jsonl'
/** Live file bound; one previous generation (`runtime.jsonl.1`) is kept beside it. */
const RUNTIME_LOG_MAX_BYTES = 2 * 1024 * 1024

const ROUTED = new Set(['worker.exited', 'worker.start_failed', 'session.interrupted', 'daemon.error'])
const MAX_CHARS = 2000
const MAX_ITEMS = 50

/** Every string and list in a record is bounded, so no single record can crowd out the rest. */
function bounded<T>(value: T): T {
  if (typeof value === 'string')
    return (value.length > MAX_CHARS ? `${value.slice(0, MAX_CHARS)}…` : value) as T
  if (Array.isArray(value)) return value.slice(-MAX_ITEMS).map(bounded) as T
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, bounded(child)])) as T
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) }
  // One string per frame: the sink's secret check then drops a frame, not the whole trace.
  const stack = error.stack
    ?.split('\n')
    .slice(1, 13)
    .map((line) => line.trim())
  return { name: error.name, message: error.message, ...(stack?.length ? { stack } : {}) }
}

/** The supervisor's audit records that belong in the runtime log, in the sink's shape. */
function runtimeLogEvent(record: unknown): AuditEvent | undefined {
  if (!record || typeof record !== 'object') return undefined
  const { kind } = record as { kind?: unknown }
  if (kind === 'worker.log') {
    const { sessionKey, level, message } = record as Record<string, unknown>
    if (level === 'debug') return undefined
    // `session`, not `sessionKey`: the sink redacts any field whose name contains "key".
    return { kind, detail: bounded({ session: sessionKey, level, message }) }
  }
  const { detail } = record as { detail?: unknown }
  if (typeof kind !== 'string' || !ROUTED.has(kind) || !detail || typeof detail !== 'object') return undefined
  return { kind, detail: bounded(detail as Record<string, unknown>) }
}

export type RuntimeLog = {
  /** Writes a supervisor audit record if it belongs here; any other record is ignored. */
  record(record: unknown): void
  /** A daemon-level failure that was handled rather than fatal. */
  error(during: string, error: unknown): void
  /** Writes the stop marker, detaches the crash monitor and flushes. */
  close(): Promise<void>
}

type CrashSource = Pick<NodeJS.Process, 'on' | 'off'>

/**
 * Opens the log with the same private-file sink and redaction as the audit, writes a start marker,
 * and records an uncaught exception or rejection before Node ends the process. A start with no stop
 * before it means the previous daemon died without running its shutdown.
 */
export function openRuntimeLog(dataDir: string, source: CrashSource = process): RuntimeLog {
  const sink = createFileAudit(join(dataDir, 'audit', RUNTIME_LOG), { maxBytes: RUNTIME_LOG_MAX_BYTES })
  const write = (event: AuditEvent): void => {
    try {
      sink.write(event)
    } catch {
      // Diagnostics must not change the outcome of whatever they describe.
    }
  }
  const onCrash = (error: unknown, origin: string): void =>
    write({
      kind: 'daemon.crashed',
      detail: bounded({ origin, ...describeError(error) }),
    })
  source.on('uncaughtExceptionMonitor', onCrash)
  write({
    kind: 'daemon.started',
    detail: {
      pid: process.pid,
      node: process.versions.node,
      version: typeof AGNES_VERSION === 'string' ? AGNES_VERSION : 'dev',
    },
  })
  let closed: Promise<void> | undefined
  return {
    record(record) {
      const event = runtimeLogEvent(record)
      if (event) write(event)
    },
    error(during, error) {
      write({
        kind: 'daemon.error',
        detail: bounded({ during, ...describeError(error) }),
      })
    },
    close() {
      closed ??= (async () => {
        source.off('uncaughtExceptionMonitor', onCrash)
        write({ kind: 'daemon.stopped', detail: { pid: process.pid } })
        await sink.close?.()
      })()
      return closed
    },
  }
}
