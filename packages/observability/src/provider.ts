import { createHash, randomBytes } from 'node:crypto'
import type { EventEnvelope } from '@agnes/protocol'
import type { ObservabilityProvider, ObservabilitySession } from './contract.js'
import { type ObservabilityConfig, validateObservability } from './config.js'
import { exportContent } from './content.js'
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
  privateContent: boolean
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
const putContent = (span: Span, value: string): void => {
  span.attributes = span.attributes.filter((row) => row.key !== 'agh.content')
  span.attributes.push(...attributes({ 'agh.content': value }))
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
    transport.add(
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
    transport.add('metrics', {
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
        root: {
          ...start('session', children.get(key), { 'session.id': hash(key) }),
          resource: { 'session.id': hash(key) },
        },
        tools: new Map(),
        lastSeq: 0,
        refs: 0,
        privateContent: false,
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
    await transport.dispose()
  }
  const provider: ObservabilityProvider & { configure(config: ObservabilityConfig): void } = {
    id: 'agnes.otel',
    version: '1.0.0',
    bindSession(key, context = {}) {
      const s = state(key)
      if (s) {
        s.refs++
        // An overlap must retain the pinned session identity and every private root.
        s.context = {
          ...context,
          ...s.context,
          privateRoots: [...new Set([...(s.context.privateRoots ?? []), ...(context.privateRoots ?? [])])],
        }
        s.root.resource ??= {}
        Object.assign(s.root.resource, {
          'session.id': hash(key),
          ...(s.context.workspace ? { 'agh.workspace.id': hash(s.context.workspace) } : {}),
          ...(s.context.generation ? { 'agh.generation.id': s.context.generation } : {}),
          ...(s.context.pin ? { 'agh.pin.id': hash(s.context.pin) } : {}),
          ...(s.context.version ? { 'service.version': s.context.version } : {}),
        })
      }
      let released = false
      return () => {
        if (released || !s) return
        released = true
        if (--s.refs > 0) return
        finishTurn(s, true, Date.now())
        end(s.root)
        sessions.delete(key)
      }
    },
    observe(key, event: Readonly<EventEnvelope>) {
      if (!config.enabled || closed || event.type.startsWith('x/feedback/')) return
      const s = state(key)
      if (!s) {
        transport.dropped++
        return
      }
      if (event.seq <= s.lastSeq) return
      s.lastSeq = event.seq
      const d = (
        event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {}
      ) as Record<string, unknown>
      const ms = Date.parse(event.ts)
      if (!Number.isFinite(ms)) return
      const parent = () => s.step ?? s.turn ?? s.root
      const scrub = (value: unknown) => {
        if (s.privateContent) return '<omitted>'
        const copy = exportContent(value, config, s.context)
        if (copy === '<omitted>')
          for (const running of sessions.values())
            if (running.root.traceId === s.root.traceId) running.privateContent = true
        return copy
      }
      const previousSpan =
        event.type === 'tool/result'
          ? (s.tools.get(String(d.toolUseId)) ?? parent())
          : event.type === 'turn/end'
            ? (s.turn ?? s.root)
            : event.type === 'step/end'
              ? (s.step ?? s.turn ?? s.root)
              : (s.model ?? parent())
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
          if (s.model && config.redaction === 'content') putContent(s.model, scrub(d.content))
          end(s.model, false, ms)
          s.model = undefined
          break
        case 'user/message':
          if (config.redaction === 'content') putContent(parent(), scrub(d.content))
          break
        case 'tool/call':
          // A result can echo private file contents without repeating its source path.
          if (scrub(d.args) === '<omitted>') s.privateContent = true
          end(s.tools.get(String(d.toolUseId)), true, ms)
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
          else transport.dropped++
          break
        case 'tool/result': {
          const span = s.tools.get(String(d.toolUseId))
          if (!span) break
          if (config.redaction === 'content') putContent(span, scrub(d.content))
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
              ? { 'agh.content': scrub(d.content ?? d.args) }
              : {}),
          }),
        },
        s.root.resource,
      )
    },
    child(parent, child, phase, failed) {
      if (!config.enabled || closed) return
      const s = state(parent)
      if (!s) return
      if (phase === 'start' && !children.has(child) && children.size < 512) {
        const span = start('child', s.turn ?? s.root, { 'child.id': hash(child) })
        children.set(child, span)
        const running = state(child)
        if (running) {
          running.root.traceId = span.traceId
          running.root.parentSpanId = span.spanId
          running.privateContent ||= s.privateContent
        }
      } else if (phase === 'end') {
        const span = children.get(child)
        end(span, failed)
        children.delete(child)
      }
    },
    lifecycle(component, phase, queueDepth, id) {
      const identity = `${component}:${id ?? 'process'}`
      if (!config.enabled || closed) return
      if (phase === 'start') {
        end(processes.get(identity), true)
        if (!processes.has(identity) && processes.size >= 512) {
          transport.dropped++
          return
        }
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
      const validated = validateObservability(next)
      // Open spans have not been queued yet. They cannot carry old consent to a new destination.
      for (const s of sessions.values()) {
        for (const span of [s.root, s.turn, s.step, s.model, ...s.tools.values()])
          if (span) span.attributes = span.attributes.filter((row) => row.key !== 'agh.content')
        if (config.enabled !== validated.enabled) {
          s.turn = s.step = s.model = undefined
          s.tools.clear()
        }
      }
      config = validated
      transport.configure(config)
    },
    health: () => (config.enabled ? transport.health() : { ...transport.health(), status: 'disabled' }),
    flush: () => transport.flush(),
    dispose() {
      disposal ??= shutdown()
      return disposal
    },
  }
  return provider
}
