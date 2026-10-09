import { createHash, randomBytes } from 'node:crypto'
import { looksLikeSecret } from '@agnes/error-sanitization'
import type { ObservabilityProvider, ObservabilitySession } from '@agnes/extension-api'
import type { EventEnvelope } from '@agnes/protocol'
import { type ObservabilityConfig, resolveHeaders, validateObservability } from './config.js'
import { OtlpTransport, type Resource } from './transport.js'

type Attributes = Record<string, string | number | boolean>
type Span = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  resource?: Resource
  attributes: Array<{
    key: string
    value: { stringValue?: string; doubleValue?: number; boolValue?: boolean }
  }>
}
type SessionState = {
  root: Span
  context: ObservabilitySession
  step?: Span | undefined
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
function content(value: unknown, config: ObservabilityConfig, roots: readonly string[]): string {
  // Bounds the hot path before parsing/string scrubbing; never recursively scans files.
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0,
    chars = 0
  while (pending.length) {
    const entry = pending.pop()!
    if (++nodes > 256 || entry.depth > 8) return '<omitted>'
    if (typeof entry.value === 'string') {
      chars += entry.value.length
      if (chars > 16384) return '<omitted>'
    } else if (entry.value && typeof entry.value === 'object') {
      for (const child in entry.value) {
        if (pending.length + nodes > 256) return '<omitted>'
        pending.push({ value: (entry.value as Record<string, unknown>)[child], depth: entry.depth + 1 })
      }
    }
  }
  let json: string
  try {
    json = JSON.stringify(value) ?? 'null'
  } catch {
    return '<omitted>'
  }
  if (json.length > 16384 || roots.some((root) => root && json.includes(root))) return '<omitted>'
  let secrets: string[]
  try {
    secrets = Object.values(resolveHeaders(config))
  } catch {
    return '<omitted>'
  }
  return JSON.stringify(JSON.parse(json), (key, item: unknown) => {
    if (/secret|password|authorization|credential|api.?key|cookie|token/i.test(key)) return '<redacted>'
    if (
      typeof item === 'string' &&
      (looksLikeSecret(item) || secrets.some((secret) => item.includes(secret)))
    )
      return '<redacted>'
    return item
  }).slice(0, 4096)
}
/** No payload leaves this provider unless an explicit administrator enables content export. */
export function createObservability(
  initial: ObservabilityConfig,
): ObservabilityProvider & { configure(config: ObservabilityConfig): void } {
  let config = validateObservability(initial)
  const transport = new OtlpTransport(config)
  const sessions = new Map<string, SessionState>()
  const children = new Map<string, Span>()
  const processes = new Map<string, Span>()
  const startedAt = nanos()
  let closed = false
  let disposal: Promise<void> | undefined
  const start = (name: string, parent?: Span, values: Attributes = {}, ms = Date.now()): Span => ({
    traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    ...(parent ? { parentSpanId: parent.spanId, resource: parent.resource } : {}),
    name,
    kind: name === 'model' ? 3 : 1,
    startTimeUnixNano: nanos(ms),
    attributes: attributes(values),
  })
  const end = (span: Span | undefined, failed = false, ms = Date.now()): void => {
    if (!span) return
    const { resource, ...wireSpan } = span
    transport?.add(
      'traces',
      {
        ...wireSpan,
        endTimeUnixNano: nanos(Math.max(Number(BigInt(span.startTimeUnixNano) / 1_000_000n), ms)),
        status: { code: failed ? 2 : 1 },
      },
      resource,
    )
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
    if (closed) return undefined
    let found = sessions.get(key)
    if (!found && sessions.size < 512) {
      found = {
        context: {},
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
    end(s.step, failed, ms)
    s.step = undefined
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
  const provider: ObservabilityProvider & { configure(config: ObservabilityConfig): void } = {
    id: 'agnes.otel',
    version: '1.0.0',
    bindSession(key, context = {}) {
      const s = state(key)
      if (s) {
        s.refs++
        s.context = context
        s.root.resource = {
          'session.id': hash(key),
          ...(context.workspace ? { 'agh.workspace.id': hash(context.workspace) } : {}),
          ...(context.generation ? { 'agh.generation.id': context.generation } : {}),
          ...(context.pin ? { 'agh.pin.id': hash(context.pin) } : {}),
          ...(context.version ? { 'service.version': context.version } : {}),
        }
      }
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
      if (!config.enabled || closed || event.type.startsWith('x/feedback/')) return
      const s = state(key)
      if (!s || event.seq <= s.lastSeq) return
      s.lastSeq = event.seq
      const d = (
        event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {}
      ) as Record<string, unknown>
      const ms = Date.parse(event.ts)
      if (!Number.isFinite(ms)) return
      const parent = () => s.step ?? s.turn ?? s.root
      const scrub = (value: unknown) => content(value, config, s.context.privateRoots ?? [])
      const previousSpan = s.model ?? s.tools.get(String(d.toolUseId)) ?? parent()
      switch (event.type) {
        case 'turn/start':
          finishTurn(s, true, ms)
          s.turn = start('turn', s.root, { 'turn.id': Number(d.turn) }, ms)
          break
        case 'step/start':
          end(s.step, true, ms)
          s.step = start('step', s.turn ?? s.root, { 'step.id': Number(d.step) }, ms)
          break
        case 'step/end':
          end(s.step, false, ms)
          s.step = undefined
          break
        case 'request/header':
          end(s.model, true, ms)
          s.model = start('model', parent(), { 'model.id': hash(String(d.model ?? 'unknown')) }, ms)
          break
        case 'assistant/message':
          if (s.model && config.redaction === 'content')
            s.model.attributes.push(...attributes({ 'agh.content': scrub(d.content) }))
          end(s.model, false, ms)
          s.model = undefined
          break
        case 'user/message':
          if (config.redaction === 'content')
            parent().attributes.push(...attributes({ 'agh.content': scrub(d.content) }))
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
          if (config.redaction === 'content')
            span.attributes.push(...attributes({ 'agh.content': scrub(d.content) }))
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
      const span = ['assistant/message', 'tool/result', 'step/end', 'turn/end'].includes(event.type)
        ? previousSpan
        : (s.model ?? s.tools.get(String(d.toolUseId)) ?? parent())
      transport.add(
        'logs',
        {
          timeUnixNano: nanos(ms),
          observedTimeUnixNano: nanos(),
          severityNumber: 9,
          traceId: span.traceId,
          spanId: span.spanId,
          body: { stringValue: event.type },
          attributes: attributes({
            'event.name': event.type,
            'agh.ledger.seq': event.seq,
            ...(config.redaction === 'content' &&
            ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(event.type)
              ? { 'agh.content': scrub(d.content ?? d.input) }
              : {}),
          }),
        },
        s.root.resource,
      )
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
      if (!config.enabled || closed || event.type.startsWith('x/feedback/')) return
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
    configure(next) {
      config = validateObservability(next)
      transport.configure(config)
    },
    health: () =>
      config.enabled
        ? transport.health()
        : { status: 'disabled', queued: 0, dropped: transport.dropped, failures: transport.failures },
    flush: () => transport?.flush() ?? Promise.resolve(),
    dispose() {
      disposal ??= shutdown()
      return disposal
    },
  }
  return provider
}
