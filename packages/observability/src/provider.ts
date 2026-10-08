import { createHash, randomBytes } from 'node:crypto'
import { looksLikeSecret } from '@agnes/error-sanitization'
import type { ObservabilityProvider } from '@agnes/extension-api'
import type { EventEnvelope } from '@agnes/protocol'
import type { ObservabilityConfig } from './config.js'
import { OtlpTransport } from './transport.js'

type Attributes = Record<string, string | number | boolean>
type Span = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  attributes: Array<{
    key: string
    value: { stringValue?: string; doubleValue?: number; boolValue?: boolean }
  }>
}
type SessionState = {
  root: Span
  turn?: Span | undefined
  model?: Span | undefined
  tools: Map<string, Span>
  lastSeq: number
  refs: number
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const nanos = (ms = Date.now()): string => String(BigInt(Math.max(0, Math.floor(ms))) * 1_000_000n)
const attributes = (values: Attributes): Span['attributes'] =>
  Object.entries(values).map(([key, value]) => ({
    key,
    value:
      typeof value === 'number'
        ? { doubleValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : { stringValue: value },
  }))
function content(value: unknown): string {
  return (
    JSON.stringify(value, (key, item: unknown) => {
      if (/secret|password|authorization|credential|api.?key|cookie|token/i.test(key)) return '<redacted>'
      if (typeof item === 'string' && looksLikeSecret(item)) return '<redacted>'
      return item
    }) ?? 'null'
  ).slice(0, 4096)
}
/** No payload leaves this provider unless an explicit administrator enables content export. */
export function createObservability(config: ObservabilityConfig): ObservabilityProvider {
  const transport = config.enabled ? new OtlpTransport(config) : undefined
  const sessions = new Map<string, SessionState>()
  const children = new Map<string, Span>()
  const processes = new Map<string, Span>()
  const startedAt = nanos()
  let closed = false
  let disposal: Promise<void> | undefined
  const start = (name: string, parent?: Span, values: Attributes = {}, ms = Date.now()): Span => ({
    traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    name,
    kind: name === 'model' ? 3 : 1,
    startTimeUnixNano: nanos(ms),
    attributes: attributes(values),
  })
  const end = (span: Span | undefined, failed = false, ms = Date.now()): void => {
    if (!span) return
    transport?.add('traces', {
      ...span,
      endTimeUnixNano: nanos(Math.max(Number(BigInt(span.startTimeUnixNano) / 1_000_000n), ms)),
      status: { code: failed ? 2 : 1 },
    })
  }
  const metric = (
    name: string,
    value: number,
    kind: 'sum' | 'gauge' | 'histogram',
    tags: Attributes = {},
  ): void => {
    if (!Number.isFinite(value) || value < 0) return
    const point = {
      attributes: attributes(tags),
      startTimeUnixNano: startedAt,
      timeUnixNano: nanos(),
      ...(kind === 'histogram' ? { count: '1', sum: value, bucketCounts: ['1'] } : { asDouble: value }),
    }
    transport?.add('metrics', {
      name,
      unit: name.endsWith('duration') ? 'ms' : '1',
      [kind]: {
        dataPoints: [point],
        ...(kind === 'gauge'
          ? {}
          : { aggregationTemporality: 1, ...(kind === 'sum' ? { isMonotonic: true } : {}) }),
      },
    })
  }
  const state = (key: string): SessionState | undefined => {
    if (!transport || closed) return undefined
    let found = sessions.get(key)
    if (!found && sessions.size < 512) {
      found = {
        root: start('session', children.get(key), { 'session.id': hash(key) }),
        tools: new Map(),
        lastSeq: 0,
        refs: 0,
      }
      sessions.set(key, found)
    }
    return found
  }
  const finishTurn = (s: SessionState, failed: boolean, ms: number): void => {
    end(s.model, true, ms)
    s.model = undefined
    for (const tool of s.tools.values()) end(tool, true, ms)
    s.tools.clear()
    if (s.turn)
      metric('agh.turn.duration', ms - Number(BigInt(s.turn.startTimeUnixNano) / 1_000_000n), 'histogram')
    end(s.turn, failed, ms)
    s.turn = undefined
  }
  const shutdown = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const s of sessions.values()) {
      finishTurn(s, true, Date.now())
      end(s.root)
    }
    for (const span of children.values()) end(span, true)
    for (const span of processes.values()) end(span)
    sessions.clear()
    children.clear()
    processes.clear()
    await transport?.dispose()
  }
  const provider: ObservabilityProvider = {
    id: 'agnes.otel',
    version: '1.0.0',
    bindSession(key) {
      const s = state(key)
      if (s) s.refs++
      let released = false
      return () => {
        if (released || !s) return
        released = true
        if (--s.refs > 0) return
        finishTurn(s, true, Date.now())
        end(s.root)
        sessions.delete(key)
        children.delete(key)
      }
    },
    observe(key, event: Readonly<EventEnvelope>) {
      const s = state(key)
      if (!s || event.seq <= s.lastSeq) return
      s.lastSeq = event.seq
      const d = (
        event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {}
      ) as Record<string, unknown>
      const ms = Date.parse(event.ts)
      if (!Number.isFinite(ms)) return
      const parent = () => s.turn ?? s.root
      switch (event.type) {
        case 'turn/start':
          finishTurn(s, true, ms)
          s.turn = start('turn', s.root, { 'turn.id': Number(d.turn) }, ms)
          break
        case 'request/header':
          end(s.model, true, ms)
          s.model = start('model', parent(), { 'model.id': hash(String(d.model ?? 'unknown')) }, ms)
          break
        case 'assistant/message':
          if (s.model && config.includeContent)
            s.model.attributes.push(...attributes({ 'agh.content': content(d.content) }))
          end(s.model, false, ms)
          s.model = undefined
          break
        case 'user/message':
          if (config.includeContent)
            parent().attributes.push(...attributes({ 'agh.content': content(d.content) }))
          break
        case 'tool/call':
          if (s.tools.size < 256)
            s.tools.set(
              String(d.toolUseId),
              start(
                'tool',
                parent(),
                { 'tool.id': hash(String(d.name)), 'call.id': hash(String(d.toolUseId)) },
                ms,
              ),
            )
          break
        case 'tool/result': {
          const span = s.tools.get(String(d.toolUseId))
          if (!span) break
          if (config.includeContent)
            span.attributes.push(...attributes({ 'agh.content': content(d.content) }))
          end(span, d.isError === true, ms)
          metric('agh.tool.duration', ms - Number(BigInt(span.startTimeUnixNano) / 1_000_000n), 'histogram')
          metric('agh.tool.calls', 1, 'sum', { error: d.isError === true })
          if (d.isError) metric('agh.tool.errors', 1, 'sum')
          s.tools.delete(String(d.toolUseId))
          break
        }
        case 'cost/ledger': {
          const tokens = d.tokens as { input?: number; output?: number } | undefined
          metric('agh.tokens.input', tokens?.input ?? 0, 'sum')
          metric('agh.tokens.output', tokens?.output ?? 0, 'sum')
          break
        }
        case 'turn/end':
          finishTurn(s, d.reason === 'error' || d.reason === 'aborted', ms)
          break
      }
    },
    child(parent, child, phase, failed) {
      const s = state(parent)
      if (!s) return
      if (phase === 'start' && !children.has(child) && children.size < 512) {
        const span = start('child', s.turn ?? s.root, { 'child.id': hash(child) })
        children.set(child, span)
        const running = sessions.get(child)
        if (running) {
          running.root.traceId = span.traceId
          running.root.parentSpanId = span.spanId
        }
      } else if (phase === 'end') {
        const span = children.get(child)
        end(span, failed)
        children.delete(child)
      }
    },
    lifecycle(component, phase, queueDepth, id) {
      const identity = `${component}:${id ?? 'process'}`
      if (!transport || closed) return
      if (phase === 'start') {
        end(processes.get(identity), true)
        processes.set(
          identity,
          start(component, processes.get('daemon:process'), id ? { 'worker.id': hash(id) } : {}),
        )
      } else if (phase === 'stop') {
        end(processes.get(identity))
        processes.delete(identity)
      } else {
        const span = start(`${component}.restart`, processes.get('daemon:process'))
        end(span)
        metric('agh.worker.restarts', 1, 'sum')
      }
      if (queueDepth !== undefined) metric('agh.queue.depth', queueDepth, 'gauge')
    },
    queueDepth(depth) {
      metric('agh.queue.depth', depth, 'gauge')
    },
    correlation(key) {
      const s = sessions.get(key)
      const span = s?.model ?? (s ? [...s.tools.values()].at(-1) : undefined) ?? s?.turn ?? s?.root
      return span ? { traceId: span.traceId, spanId: span.spanId } : undefined
    },
    flush: () => transport?.flush() ?? Promise.resolve(),
    dispose() {
      disposal ??= shutdown()
      return disposal
    },
  }
  return provider
}
