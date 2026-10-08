import type { ObservabilityConfig } from './config.js'

type Point = {
  attributes: unknown[]
  startTimeUnixNano: string
  timeUnixNano: string
  asDouble?: number
  count?: string
  sum?: number
  bucketCounts?: string[]
}
type Metric = { name: string; unit: string } & Partial<
  Record<
    'sum' | 'histogram' | 'gauge',
    { dataPoints: Point[]; aggregationTemporality?: number; isMonotonic?: boolean }
  >
>

/** One data point per metric/attribute identity in a batch; delta intervals do not overlap. */
function aggregateMetrics(values: unknown[], previous: Map<string, string>): Metric[] {
  const metrics = new Map<string, Metric>()
  const points = new Map<string, Point>()
  for (const input of values) {
    const metric = input as Metric
    const kind = metric.sum ? 'sum' : metric.histogram ? 'histogram' : 'gauge'
    const data = metric[kind]!
    const identity = JSON.stringify([metric.name, metric.unit, kind])
    let output = metrics.get(identity)
    if (!output) {
      output = { name: metric.name, unit: metric.unit, [kind]: { ...data, dataPoints: [] } }
      metrics.set(identity, output)
    }
    for (const point of data.dataPoints) {
      const key = JSON.stringify([identity, point.attributes])
      const found = points.get(key)
      if (!found) {
        const first = {
          ...point,
          ...(kind !== 'gauge' && previous.has(key) ? { startTimeUnixNano: previous.get(key)! } : {}),
        }
        points.set(key, first)
        output[kind]!.dataPoints.push(first)
      } else {
        found.timeUnixNano = point.timeUnixNano
        if (kind === 'sum') found.asDouble = (found.asDouble ?? 0) + (point.asDouble ?? 0)
        else if (kind === 'histogram') {
          found.count = String(BigInt(found.count ?? '0') + BigInt(point.count ?? '0'))
          found.sum = (found.sum ?? 0) + (point.sum ?? 0)
          found.bucketCounts = [found.count]
        } else found.asDouble = point.asDouble ?? 0
      }
    }
  }
  for (const [key, point] of points) {
    previous.set(key, point.timeUnixNano)
    if (previous.size > 1024) previous.delete(previous.keys().next().value!)
  }
  return [...metrics.values()]
}

/** Bounded OTLP/HTTP JSON delivery. No global SDK, ambient auth, redirects or execution dependency. */
export class OtlpTransport {
  private queue: Array<{ signal: 'traces' | 'metrics'; value: unknown }> = []
  private bytes = 0
  private readonly metricEnds = new Map<string, string>()
  private pending?: Promise<void> | undefined
  private closed = false
  private closing?: Promise<void>
  private readonly abort = new AbortController()
  private readonly timer: ReturnType<typeof setInterval>
  dropped = 0
  failures = 0
  constructor(private readonly config: ObservabilityConfig) {
    this.timer = setInterval(() => void this.flush(), config.batchMs ?? 1000)
    this.timer.unref()
  }
  add(signal: 'traces' | 'metrics', value: unknown): void {
    if (this.closed) return
    const size = Buffer.byteLength(JSON.stringify(value))
    if (this.queue.length >= 1024 || this.bytes + size > 1024 * 1024) {
      this.dropped++
      return
    }
    this.queue.push({ signal, value })
    this.bytes += size
  }
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.pending ??= this.send().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }
  private async send(): Promise<void> {
    const batch = this.queue.splice(0)
    this.bytes = 0
    for (const signal of ['traces', 'metrics'] as const) {
      const rows = batch.filter((row) => row.signal === signal).map((row) => row.value)
      const values = signal === 'metrics' ? aggregateMetrics(rows, this.metricEnds) : rows
      if (!values.length || this.closed) continue
      const endpoint = signal === 'traces' ? this.config.tracesEndpoint : this.config.metricsEndpoint
      const base = new URL(this.config.endpoint ?? endpoint!)
      base.pathname = `${base.pathname.replace(/\/$/, '')}/v1/${signal}`
      const url = endpoint ?? base.href
      const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'agnes-harness' } }] }
      const scope = { name: '@agnes/observability', version: '1.0.0' }
      const body = JSON.stringify(
        signal === 'traces'
          ? { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: values }] }] }
          : { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: values }] }] },
      )
      for (let attempt = 0; attempt < 3 && !this.closed; attempt++) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { ...this.config.headers, 'content-type': 'application/json' },
            body,
            redirect: 'error',
            signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.config.timeoutMs ?? 3000)]),
          })
          const retry = [429, 502, 503, 504].includes(response.status)
          // Read only a bounded response: collectors may return partialSuccess or arbitrary text.
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
                throw new Error('OTLP response exceeds limit')
              }
              chunks.push(next.value)
            }
          } finally {
            reader?.releaseLock()
          }
          const text = Buffer.concat(chunks).toString('utf8')
          if (response.ok && text.length <= 64 * 1024) {
            const result = text
              ? (JSON.parse(text) as {
                  partialSuccess?: { rejectedSpans?: string; rejectedDataPoints?: string }
                })
              : {}
            if (
              Number(result.partialSuccess?.rejectedSpans ?? result.partialSuccess?.rejectedDataPoints ?? 0)
            )
              this.failures++
            break
          }
          if (!retry || attempt === 2) {
            this.failures++
            break
          }
        } catch {
          if (attempt === 2 || this.closed) {
            this.failures++
            break
          }
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 50 * 2 ** attempt)
          const signal = this.abort.signal
          function done() {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            resolve()
          }
          if (signal.aborted) done()
          else signal.addEventListener('abort', done, { once: true })
        })
      }
    }
  }
  dispose(): Promise<void> {
    this.closing ??= this.close()
    return this.closing
  }
  private async close(): Promise<void> {
    if (this.closed) return
    clearInterval(this.timer)
    const deadline = setTimeout(() => {
      this.closed = true
      this.abort.abort()
    }, this.config.timeoutMs ?? 3000)
    try {
      await this.flush()
      await this.flush()
    } finally {
      clearTimeout(deadline)
      this.closed = true
      this.abort.abort()
      this.queue = []
      this.bytes = 0
    }
  }
}
