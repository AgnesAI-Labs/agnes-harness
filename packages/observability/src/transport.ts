import type { ObservabilityHealth } from '@agnes/extension-api'
import { deploymentFetch } from '@agnes/system-node/deployment-network'
import { type ObservabilityConfig, resolveHeaders, validateObservability } from './config.js'
import { aggregateMetrics } from './metrics.js'

export type Resource = Record<string, string>
type Signal = 'traces' | 'metrics' | 'logs'
type Row = { signal: Signal; value: unknown; resource: Resource; size: number; config: ObservabilityConfig }
const attributes = (values: Resource) =>
  Object.entries(values).map(([key, stringValue]) => ({ key, value: { stringValue } }))

/** One bounded queue, including in-flight records. Collector failures never escape to execution. */
export class OtlpTransport {
  private queue: Row[] = []
  private bytes = 0
  private readonly metricEnds = new Map<string, string>()
  private pending: Promise<void> | undefined
  private closed = false
  private closing: Promise<void> | undefined
  private readonly abort = new AbortController()
  private timer: ReturnType<typeof setInterval> | undefined
  private scheduled = false
  private retryAt = 0
  private attempts = 0
  private lastExportAt: string | undefined
  private lastStatus: ObservabilityHealth['status'] = 'idle'
  dropped = 0
  failures = 0
  constructor(private config: ObservabilityConfig) {
    this.config = validateObservability(config)
    this.schedule()
  }
  configure(config: ObservabilityConfig): void {
    this.config = validateObservability(config)
    this.schedule()
  }
  private schedule(): void {
    clearInterval(this.timer)
    this.timer = undefined
    if (this.closed || (!this.config.enabled && !this.queue.length)) return
    this.timer = setInterval(() => void this.flush(false), Math.min(this.config.batchMs ?? 1000, 1000))
    this.timer.unref()
  }
  health(): ObservabilityHealth {
    return {
      status: this.closed ? 'closed' : this.lastStatus,
      queued: this.queue.length,
      dropped: this.dropped,
      failures: this.failures,
      ...(this.lastExportAt ? { lastExportAt: this.lastExportAt } : {}),
    }
  }
  add(signal: Signal, value: unknown, resource: Resource = {}): void {
    if (this.closed || this.closing || !this.config.enabled) return
    const size = Buffer.byteLength(JSON.stringify([value, resource])) + 512
    if (this.queue.length >= (this.config.queueSize ?? 1024) || this.bytes + size > 1024 * 1024) {
      this.dropped++
      return
    }
    this.queue.push({ signal, value, resource: { ...resource }, size, config: this.config })
    this.bytes += size
    if (
      !this.scheduled &&
      this.queue.length >= (this.config.batchSize ?? Math.min(256, this.config.queueSize ?? 1024))
    ) {
      this.scheduled = true
      queueMicrotask(() => {
        this.scheduled = false
        void this.flush(false)
      })
    }
  }
  flush(force = true): Promise<void> {
    if (this.closed || Date.now() < this.retryAt) return Promise.resolve()
    if (
      !force &&
      this.queue.length < (this.config.batchSize ?? Math.min(256, this.config.queueSize ?? 1024)) &&
      Date.now() - this.lastFlush < (this.config.batchMs ?? 1000)
    )
      return Promise.resolve()
    this.pending ??= this.drain().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }
  private lastFlush = Date.now()
  private async drain(): Promise<void> {
    this.lastFlush = Date.now()
    while (!this.closed && this.queue.length) {
      const first = this.queue[0]!
      const rows: Row[] = []
      for (const row of this.queue) {
        if (
          row.signal !== first.signal ||
          row.config !== first.config ||
          JSON.stringify(row.resource) !== JSON.stringify(first.resource) ||
          rows.length >= (first.config.batchSize ?? Math.min(256, first.config.queueSize ?? 1024))
        )
          break
        rows.push(row)
      }
      const resource = {
        attributes: attributes({
          'service.name': 'agnes-harness',
          'service.version': '0.0.0',
          ...first.resource,
        }),
      }
      const scope = { name: '@agnes/observability', version: '1.0.0' }
      const values =
        first.signal === 'metrics'
          ? aggregateMetrics(
              rows.map((row) => row.value),
              new Map(this.metricEnds),
            )
          : rows.map((row) => row.value)
      const body = JSON.stringify(
        first.signal === 'traces'
          ? { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: values }] }] }
          : first.signal === 'logs'
            ? { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: values }] }] }
            : { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: values }] }] },
      )
      const result = await this.send(first, body, rows.length)
      if (result === 'retry') {
        this.failures++
        this.lastStatus = 'backoff'
        this.retryAt = Date.now() + Math.min(30000, 100 * 2 ** Math.min(this.attempts++, 8))
        return
      }
      this.queue.splice(0, rows.length)
      this.bytes -= rows.reduce((size, row) => size + row.size, 0)
      if (first.signal === 'metrics' && result === 0)
        aggregateMetrics(
          rows.map((row) => row.value),
          this.metricEnds,
        )
      this.dropped += result
      if (result) {
        this.failures++
        this.lastStatus = 'rejected'
      } else {
        this.lastStatus = 'ok'
        this.lastExportAt = new Date().toISOString()
      }
      this.attempts = 0
      this.retryAt = 0
    }
    if (!this.config.enabled) this.schedule()
  }
  private async send(row: Row, body: string, count: number): Promise<number | 'retry'> {
    try {
      const config = row.config
      const endpoint = config[`${row.signal}Endpoint`]
      const base = new URL(config.endpoint ?? endpoint!)
      base.pathname = `${base.pathname.replace(/\/$/, '')}/v1/${row.signal}`
      const response = await deploymentFetch(endpoint ?? base.href, {
        method: 'POST',
        headers: { ...resolveHeaders(config), 'content-type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(config.timeoutMs ?? 3000)]),
      })
      if (!response.ok) {
        await response.body?.cancel()
        return [429, 502, 503, 504].includes(response.status) ? 'retry' : count
      }
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        while (reader) {
          const next = await reader.read()
          if (next.done) break
          total += next.value.byteLength
          if (total > 64 * 1024) {
            await reader.cancel()
            return count
          }
          chunks.push(next.value)
        }
      } finally {
        reader?.releaseLock()
      }
      const text = Buffer.concat(chunks).toString('utf8')
      let partial: Record<string, string> | undefined
      try {
        partial = text
          ? (JSON.parse(text) as { partialSuccess?: Record<string, string> }).partialSuccess
          : undefined
      } catch {
        return count
      }
      const rejected = Number(
        partial?.rejectedSpans ?? partial?.rejectedLogRecords ?? partial?.rejectedDataPoints ?? 0,
      )
      return Number.isSafeInteger(rejected) && rejected >= 0 ? Math.min(count, rejected) : count
    } catch {
      return 'retry'
    }
  }
  dispose(): Promise<void> {
    this.closing ??= this.close()
    return this.closing
  }
  private async close(): Promise<void> {
    clearInterval(this.timer)
    const deadline = setTimeout(() => {
      this.closed = true
      this.abort.abort()
    }, this.config.timeoutMs ?? 3000)
    try {
      if (this.config.shutdownPolicy !== 'discard') {
        while (!this.closed && this.queue.length) {
          await this.flush()
          if (this.retryAt > Date.now())
            await new Promise((resolve) => setTimeout(resolve, Math.min(50, this.retryAt - Date.now())))
        }
      }
    } finally {
      this.closed = true
      this.abort.abort()
      await this.pending
      clearTimeout(deadline)
      this.dropped += this.queue.length
      this.queue = []
      this.bytes = 0
    }
  }
}
