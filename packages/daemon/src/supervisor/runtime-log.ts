import { existsSync, lstatSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createFileAudit } from '@agnes/host'
import { publicErrorContract } from '@agnes/protocol'
import { workerBootFailureCode } from '@agnes/worker-runtime'
import { bestEffortOperations } from './best-effort.js'
import { OWNER_INPUT_TRACE_KIND, ownerInputAuditRecord } from './managed-input-trace.js'

const KINDS = new Set([
  'worker.log',
  'worker.stderr',
  'worker.exited',
  'worker.start_failed',
  'session.interrupted',
  'daemon.error',
])
const CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'EACCES',
  'EPERM',
  'ENOMEM',
  'EPIPE',
  'ECONNRESET',
])
/** Retain at most 64 KiB of byte evidence and one known failure code, never stderr text. */
export function workerStderrEvidence() {
  let bytes = 0
  let tail = ''
  let code: string | undefined
  const pattern = new RegExp(`\\b(${[...CODES].join('|')})\\b`)
  return {
    push(chunk: Buffer) {
      const part = chunk.subarray(0, Math.max(0, 64 * 1024 - bytes))
      bytes += part.length
      if (!part.length) return
      const text = tail + part.toString('utf8')
      code ??= pattern.exec(text)?.[1]
      tail = text.slice(-32)
    },
    snapshot: () => ({ bytes, ...(code ? { code } : {}) }),
  }
}

/** Runtime evidence deliberately excludes arbitrary worker text, paths and exception bodies. */
export function openRuntimeLog(
  dataDir: string,
  source: Pick<NodeJS.Process, 'on' | 'off'> = process,
  maxBytes = 2 * 1024 * 1024,
) {
  const log = rotatingLog(join(dataDir, 'audit', 'runtime.jsonl'), maxBytes)
  let closed = false
  const write = (kind: string, detail: Record<string, unknown> = {}) => {
    if (!closed) log.write(kind, detail)
  }
  const crash = () => write('daemon.crashed')
  source.on('uncaughtExceptionMonitor', crash)
  write('daemon.started', { pid: process.pid })
  return {
    record(value: unknown) {
      if (!value || typeof value !== 'object') return
      const record = value as Record<string, unknown>
      if (typeof record.kind !== 'string' || !KINDS.has(record.kind) || record.level === 'debug') return
      const data =
        record.detail && typeof record.detail === 'object'
          ? (record.detail as Record<string, unknown>)
          : record
      const detail: Record<string, unknown> = {}
      for (const key of ['pid', 'bytes', 'lines', 'exitCode'])
        if (Number.isSafeInteger(data[key]) && Number(data[key]) >= 0) detail[key] = data[key]
      if (typeof data.level === 'string' && ['info', 'warn', 'error'].includes(data.level))
        detail.level = data.level
      if (
        typeof data.code === 'string' &&
        (CODES.has(data.code) || workerBootFailureCode(data.code) || publicErrorContract(data.code))
      )
        detail.code = data.code
      if (record.kind === 'daemon.error' && bestEffortOperations.some((label) => label === data.operation))
        detail.operation = data.operation
      if (typeof data.signal === 'string' && /^SIG[A-Z]{2,12}$/.test(data.signal)) detail.signal = data.signal
      write(record.kind, detail)
    },
    async close() {
      if (closed) return
      write('daemon.stopped', { pid: process.pid })
      closed = true
      source.off('uncaughtExceptionMonitor', crash)
      await log.close()
    },
  }
}

/** One JSONL file kept under `maxBytes`, the previous one as `<file>.1`; a regular, single-link file only. */
function rotatingLog(file: string, maxBytes: number) {
  const safe = () => {
    if (!existsSync(file)) return
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('unsafe runtime log')
  }
  safe()
  let sink = createFileAudit(file)
  return {
    write(kind: string, detail: Record<string, unknown>) {
      try {
        safe()
        if (existsSync(file) && lstatSync(file).size >= maxBytes) {
          renameSync(file, `${file}.1`)
          sink = createFileAudit(file)
        }
        sink.write({ kind, detail })
      } catch {
        /* Diagnostic failures never change execution outcomes. */
      }
    },
    close: async () => void (await sink.close?.()),
  }
}

/**
 * `<dataDir>/audit/owner-input.jsonl`: the owner input engine's trace, rotated like the runtime log.
 * Only the allowlisted fields of `ownerInputAuditRecord` are written: never text, receipts or credentials.
 */
export function openOwnerInputLog(dataDir: string, maxBytes = 2 * 1024 * 1024) {
  const log = rotatingLog(join(dataDir, 'audit', 'owner-input.jsonl'), maxBytes)
  return {
    record(value: unknown) {
      const detail = ownerInputAuditRecord(value)
      if (detail) log.write(OWNER_INPUT_TRACE_KIND, detail)
    },
    close: log.close,
  }
}

/** Lifecycle-owned audit fanout; request logs retain their existing vocabulary and format. */
export function openDaemonLogs(dataDir: string) {
  const runtime = openRuntimeLog(dataDir)
  const requests = createFileAudit(join(dataDir, 'audit', 'daemon.jsonl'))
  let ownerInputs: ReturnType<typeof openOwnerInputLog> | undefined
  return {
    record(record: unknown) {
      runtime.record(record)
      if (!record || typeof record !== 'object' || !('kind' in record)) return
      if (record.kind === OWNER_INPUT_TRACE_KIND) {
        try {
          // Opened on first use, so a daemon without managed inputs leaves no file.
          ownerInputs ??= openOwnerInputLog(dataDir)
          ownerInputs.record('detail' in record ? record.detail : undefined)
        } catch {
          /* Diagnostic failures never change execution outcomes. */
        }
        return
      }
      if (record.kind === 'daemon.request_failed' || record.kind === 'plugin.tree.reverted')
        requests.write({
          kind: record.kind,
          ...('detail' in record ? { detail: record.detail as Record<string, unknown> } : {}),
        })
    },
    async close() {
      try {
        await runtime.close()
      } finally {
        await requests.close?.()
        await ownerInputs?.close()
      }
    },
  }
}
