import { existsSync, lstatSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createFileAudit } from '@agnes/host'
import { workerBootFailureCode } from '@agnes/worker-runtime'

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
  const file = join(dataDir, 'audit', 'runtime.jsonl')
  const safe = () => {
    if (!existsSync(file)) return
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('unsafe runtime log')
  }
  safe()
  let sink = createFileAudit(file)
  let closed = false
  const write = (kind: string, detail: Record<string, unknown> = {}) => {
    if (closed) return
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
      const prewarm =
        record.kind === 'worker.log' && typeof record.message === 'string'
          ? /^Default composition prewarm (ready|failed|reused) rssBefore=(\d+) rssAfter=(\d+)$/.exec(
              record.message,
            )
          : null
      if (prewarm && Number.isSafeInteger(Number(prewarm[2])) && Number.isSafeInteger(Number(prewarm[3]))) {
        detail.prewarm = prewarm[1]
        detail.rssBefore = Number(prewarm[2])
        detail.rssAfter = Number(prewarm[3])
      }
      for (const key of ['pid', 'bytes', 'lines', 'exitCode'])
        if (Number.isSafeInteger(data[key]) && Number(data[key]) >= 0) detail[key] = data[key]
      if (typeof data.level === 'string' && ['info', 'warn', 'error'].includes(data.level))
        detail.level = data.level
      if (typeof data.code === 'string' && (CODES.has(data.code) || workerBootFailureCode(data.code)))
        detail.code = data.code
      if (typeof data.signal === 'string' && /^SIG[A-Z]{2,12}$/.test(data.signal)) detail.signal = data.signal
      write(record.kind, detail)
    },
    async close() {
      if (closed) return
      write('daemon.stopped', { pid: process.pid })
      closed = true
      source.off('uncaughtExceptionMonitor', crash)
      await sink.close?.()
    },
  }
}

/** Lifecycle-owned audit fanout; request logs retain their existing vocabulary and format. */
export function openDaemonLogs(dataDir: string) {
  const runtime = openRuntimeLog(dataDir)
  const requests = createFileAudit(join(dataDir, 'audit', 'daemon.jsonl'))
  return {
    record(record: unknown) {
      runtime.record(record)
      if (!record || typeof record !== 'object' || !('kind' in record)) return
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
      }
    },
  }
}
