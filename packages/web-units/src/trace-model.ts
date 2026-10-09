import type { UINode, UISpan, UITurn } from '@agnes/protocol'
import { type TraceMessageKey, traceLocale, traceText } from './trace-locale.js'
import { type TraceMetric, type TraceTokenMetrics } from './trace-request-metrics.js'

export const BADGE_KEY: Record<string, TraceMessageKey> = {
  user: 'trace.badge.user',
  context: 'trace.badge.context',
  assistant: 'trace.badge.assistant',
  tool: 'trace.badge.tool',
  approval: 'trace.badge.approval',
  compaction: 'trace.badge.compaction',
  cost: 'trace.badge.cost',
}

const STATUS_KEY: Record<string, TraceMessageKey> = {
  running: 'trace.status.running',
  waiting: 'trace.status.waiting',
  completed: 'trace.status.completed',
  failed: 'trace.status.failed',
  cancelled: 'trace.status.cancelled',
  planned: 'trace.status.planned',
  awaiting_approval: 'trace.status.awaiting_approval',
}

export type TraceRow = {
  requestTraceId?: string | undefined
  id: string
  seq: number
  turn?: number | undefined
  step?: string | undefined
  kind: string
  badge: string
  statusCode: string
  preview: string
  raw: string
  rawNote?: string | undefined
  attachments?: readonly string[] | undefined
  source: string
  status: string
  errorCode?: string | undefined
  startedAt?: string | undefined
  durationMs?: number | undefined
  ttftMs?: number | undefined
  model?: string | undefined
  usage?: UITurn['usage'] | undefined
  callUsage?: UITurn['usage']['calls'][number] | undefined
}

export type GanttBar = {
  key: string
  truncated?: string
  targetId?: string
  marker?: boolean
  lane: 'input' | 'model' | 'tool'
  tone?: 'user' | 'context' | 'system'
  left: number
  width: number
  end: number
  domainStart: number
  domainEnd: number
  title: string
}
type GanttModel = { bars: GanttBar[]; start: number; end: number }

export type TimelineMode = 'sequence' | 'duration' | 'time' | 'actual'
export type TimelineRange = { start: number; end: number }
export const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`

export const durationLabel = (duration?: number): string => {
  if (duration === undefined) return traceText('trace.duration.running')
  if (duration < 1000) return traceText('trace.duration.ms', { n: duration })
  if (duration < 60_000)
    return traceText('trace.duration.seconds', { n: (duration / 1000).toFixed(duration < 10_000 ? 1 : 0) })
  return traceText('trace.duration.minutes', {
    minutes: Math.floor(duration / 60_000),
    seconds: Math.round((duration % 60_000) / 1000),
  })
}

export const tokenLabel = (
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number },
  reasoningKnown: boolean,
): string =>
  traceText('trace.token.line', {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    reasoning: reasoningKnown ? (tokens.reasoning ?? '') : traceText('trace.token.unavailable'),
  })

export const metricLabel = (metric: TraceMetric<number>): string =>
  metric.state === 'known'
    ? String(metric.value)
    : metric.reason === 'earlier-history-unloaded'
      ? traceText('trace.metric.earlierUnloaded')
      : metric.reason === 'request-order-unverifiable'
        ? traceText('trace.metric.unverifiable')
        : traceText('trace.metric.unrecorded')

export const metricTokensLabel = (tokens: TraceTokenMetrics): string =>
  traceText('trace.token.line', {
    input: metricLabel(tokens.input),
    output: metricLabel(tokens.output),
    cacheRead: metricLabel(tokens.cacheRead),
    cacheWrite: metricLabel(tokens.cacheWrite),
    reasoning: metricLabel(tokens.reasoning),
  })

const walkSpans = (span: UISpan, visit: (item: UISpan) => void): void => {
  visit(span)
  for (const child of span.children) walkSpans(child, visit)
}

const nodePreview = (node: UINode): string => {
  if (node.kind === 'user') {
    const message = node.content
      .filter(
        (block): block is Extract<(typeof node.content)[number], { type: 'text' }> => block.type === 'text',
      )
      .map((block) => block.text)
      .join('\n')
    const images = node.content.filter((block) => block.type === 'image').length
    const resources = node.content.filter((block) => block.type === 'resource_link').length
    return [
      message,
      images ? traceText(images === 1 ? 'trace.preview.image' : 'trace.preview.images', { n: images }) : '',
      resources
        ? traceText(resources === 1 ? 'trace.preview.resource' : 'trace.preview.resources', { n: resources })
        : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (node.kind === 'assistant') return node.text || node.thinking || ''
  if (node.kind === 'context') return node.text
  if (node.kind === 'tool') {
    const summary = node.summary && node.summary !== node.name ? ` · ${node.summary}` : ''
    const args = node.argsPreview ? ` ${node.argsPreview}` : ''
    const result = node.resultPreview ? ` → ${node.resultPreview}` : ''
    return `${node.name}${summary}${args}${result}`
  }
  if (node.kind === 'approval') return node.summary
  if (node.kind === 'compaction') return node.summary ?? ''
  if (node.kind === 'cost') return node.model ?? node.purpose ?? ''
  if (node.kind === 'artifact') return node.name
  return ''
}

const nodeRaw = (node: UINode): string => {
  if (node.kind === 'assistant') return [node.thinking, node.text].filter(Boolean).join('\n\n')
  if (node.kind === 'tool')
    return [traceText('trace.raw.tool', { name: node.name }), node.argsPreview, node.resultPreview]
      .filter(Boolean)
      .join('\n\n')
  return nodePreview(node)
}

const userAttachments = (node: UINode): string[] => {
  if (node.kind !== 'user') return []
  return node.content.flatMap((block) => {
    if (block.type === 'image') return [traceText('trace.attachment.image', { mime: block.mimeType })]
    if (block.type === 'resource_link') {
      const name = `${block.name ?? traceText('trace.attachment.unnamed')}${block.mimeType ? ` · ${block.mimeType}` : ''}`
      return [traceText('trace.attachment.resource', { name })]
    }
    return []
  })
}

const nodeSource = (node: UINode): string => {
  if (node.kind === 'user')
    return node.actorLabel
      ? traceText('trace.source.userActor', { actor: node.actorLabel })
      : traceText('trace.source.user')
  if (node.kind === 'assistant') return traceText('trace.source.model')
  if (node.kind === 'tool') return traceText('trace.source.tool', { name: node.name })
  if (node.kind === 'context') return traceText('trace.source.context')
  if (node.kind === 'approval') return traceText('trace.source.approval')
  if (node.kind === 'compaction') return traceText('trace.source.compaction')
  return node.kind
}

const LIST_KINDS = new Set(['user', 'context', 'assistant', 'tool', 'approval', 'compaction'])

/** A span placed where the trace shortened a subtree; its message is how many steps it stands for. */
const isTruncation = (span: UISpan): boolean => span.error?.code === 'TRACE_TRUNCATED'
const truncationLabel = (span: UISpan): string => {
  const n = span.error?.message ?? traceText('trace.truncated.some')
  return traceText(n === '1' ? 'trace.truncated.one' : 'trace.truncated', { n })
}

type Placed = { span: UISpan; order: number; step: string | undefined }

/**
 * One pass over a snapshot. A node belongs to the first turn that lists it and to the span that
 * comes first in turn and depth-first order among those naming it by id or, for a tool node, by
 * tool use; nodes no turn lists fall back to the turn whose sequence range holds them.
 */
function indexTrace(turns: readonly UITurn[]) {
  const turnByNode = new Map<string, UITurn>()
  const spanByNode = new Map<string, Placed>()
  const spanByToolUse = new Map<string, Placed>()
  let order = 0
  for (const turn of turns) {
    for (const id of turn.nodeIds) if (!turnByNode.has(id)) turnByNode.set(id, turn)
    if (!turn.trace) continue
    const visit = (span: UISpan, step?: string): void => {
      const currentStep = span.kind === 'step' ? span.name : step
      const placed = { span, order: order++, step: currentStep }
      for (const id of span.nodeIds ?? []) if (!spanByNode.has(id)) spanByNode.set(id, placed)
      if (span.toolUseId && !spanByToolUse.has(span.toolUseId)) spanByToolUse.set(span.toolUseId, placed)
      for (const child of span.children) visit(child, currentStep)
    }
    visit(turn.trace)
  }
  return {
    turnFor(node: Exclude<UINode, { kind: 'slot' }>): UITurn | undefined {
      return (
        turnByNode.get(node.id) ??
        turns.find(
          (turn) => node.seq >= turn.startSeq && (turn.endSeq === undefined || node.seq <= turn.endSeq),
        )
      )
    },
    spanFor(node: UINode): Placed | undefined {
      const byId = spanByNode.get(node.id)
      const byTool = node.kind === 'tool' ? spanByToolUse.get(node.toolUseId) : undefined
      if (!byTool) return byId
      return !byId || byTool.order < byId.order ? byTool : byId
    },
  }
}

// A row depends only on its node, turn and span; unchanged objects are reused across snapshots.
const rowCache = new WeakMap<
  UINode,
  { locale: string; turn: UITurn | undefined; span: UISpan | undefined; row: TraceRow }
>()

export function buildTraceRows(nodes: readonly UINode[], turns: readonly UITurn[]): TraceRow[] {
  const index = indexTrace(turns)
  const rows: TraceRow[] = []
  for (const node of nodes) {
    if (node.kind === 'slot' || !LIST_KINDS.has(node.kind)) continue
    const turn = index.turnFor(node)
    const placed = index.spanFor(node)
    const span = placed?.span
    const preview = nodePreview(node).replace(/\s+/g, ' ').trim()
    const raw = nodeRaw(node)
    const attachments = userAttachments(node)
    const statusCode = node.kind === 'tool' ? node.status : (span?.status ?? 'completed')
    const status = traceText(STATUS_KEY[statusCode] ?? 'trace.status.completed')
    const errorCode = span && !isTruncation(span) ? span.error?.code : undefined
    const usage = turn?.usage?.calls.length ? turn.usage : undefined
    const callUsage =
      span?.callSeq === undefined
        ? undefined
        : turn?.usage?.calls.find((call) => call.seq === span.callSeq && !call.adjustment)
    const locale = traceLocale()
    const cached = rowCache.get(node)
    if (
      cached &&
      cached.locale === locale &&
      cached.turn === turn &&
      cached.span === span &&
      cached.row.step === placed?.step &&
      cached.row.preview === preview &&
      cached.row.raw === raw &&
      (cached.row.attachments ?? []).join('\u0000') === attachments.join('\u0000') &&
      cached.row.status === status &&
      cached.row.startedAt === span?.startedAt &&
      cached.row.durationMs === span?.durationMs &&
      cached.row.ttftMs === span?.ttftMs &&
      cached.row.errorCode === errorCode &&
      cached.row.usage === usage &&
      cached.row.callUsage === callUsage &&
      cached.row.requestTraceId === span?.requestTraceId
    ) {
      rows.push(cached.row)
      continue
    }
    const row: TraceRow = {
      id: node.id,
      seq: node.seq,
      turn: turn?.turn,
      step: placed?.step,
      kind: node.kind,
      badge: traceText(BADGE_KEY[node.kind] ?? 'trace.badge.assistant'),
      preview,
      raw,
      ...(node.kind === 'tool' ? { rawNote: traceText('trace.note.tool') } : {}),
      ...(attachments.length ? { attachments, rawNote: traceText('trace.note.attachments') } : {}),
      source: nodeSource(node),
      status,
      statusCode,
      startedAt: span?.startedAt,
      durationMs: span?.durationMs,
      ttftMs: span?.ttftMs,
      model: span?.model,
      errorCode,
      usage,
      callUsage,
      requestTraceId: span?.requestTraceId,
    }
    rowCache.set(node, { locale, turn, span, row })
    rows.push(row)
  }
  return rows
}

/** Called through this object so a test can count how often the list is rebuilt. */
export const traceRowBuilder = { build: buildTraceRows }

type GanttEvent = {
  key: string
  truncated?: string
  targetId?: string
  lane: GanttBar['lane']
  tone?: GanttBar['tone']
  start: number
  end: number
  title: string
}

const IDLE_GAP_MS = 120

function projectTimedEvents(events: GanttEvent[], mode: Exclude<TimelineMode, 'sequence'>): GanttModel {
  if (events.length === 0) return { bars: [], start: 0, end: 1 }
  const ordered = [...events].sort((a, b) => a.start - b.start || a.end - b.end)
  const origin = ordered[0]?.start ?? 0
  let coveredUntil = origin
  let removedIdle = 0
  const placed: Array<GanttEvent & { compactStart: number; compactEnd: number }> = []
  for (const event of ordered) {
    const gap = event.start - coveredUntil
    if (mode === 'duration' && gap > IDLE_GAP_MS) removedIdle += gap - 48
    const compactStart = event.start - origin - removedIdle
    const compactEnd =
      (mode === 'time' ? event.start : Math.max(event.end, event.start)) - origin - removedIdle
    placed.push({ ...event, compactStart, compactEnd })
    coveredUntil = Math.max(coveredUntil, event.end, event.start)
  }
  let total = 1
  for (const event of placed) total = Math.max(total, event.compactEnd)
  return {
    start: 0,
    end: total,
    bars: placed.map((event) => ({
      key: event.key,
      ...(event.truncated ? { truncated: event.truncated } : {}),
      ...(event.targetId ? { targetId: event.targetId } : {}),
      ...(event.compactEnd <= event.compactStart ? { marker: true } : {}),
      lane: event.lane,
      ...(event.tone ? { tone: event.tone } : {}),
      left: (event.compactStart / total) * 100,
      width:
        event.compactEnd <= event.compactStart
          ? 0
          : Math.max(1.8, ((event.compactEnd - event.compactStart) / total) * 100),
      end: (event.compactEnd / total) * 100,
      domainStart: event.compactStart,
      domainEnd: event.compactEnd,
      title: event.title,
    })),
  }
}

export function buildGantt(
  turns: readonly UITurn[],
  nodes: readonly UINode[] = [],
  rows: readonly TraceRow[] = [],
  mode: TimelineMode = 'duration',
): GanttModel {
  if (mode === 'sequence') {
    return {
      start: 0,
      end: Math.max(1, rows.length),
      bars: rows.map((row, index) => ({
        key: `row:${row.id}`,
        targetId: row.id,
        lane:
          row.kind === 'user' || row.kind === 'context' ? 'input' : row.kind === 'tool' ? 'tool' : 'model',
        ...(row.kind === 'user' ? { tone: 'user' as const } : {}),
        ...(row.kind === 'context' ? { tone: 'context' as const } : {}),
        left: (index / rows.length) * 100,
        end: ((index + 1) / rows.length) * 100,
        width: 100 / rows.length,
        domainStart: index,
        domainEnd: index + 1,
        title: `${row.source} · ${clip(row.preview, 120)}`,
      })),
    }
  }
  const events: GanttEvent[] = []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const rowNodeIds = new Set(nodes.filter((node) => LIST_KINDS.has(node.kind)).map((node) => node.id))
  const toolByUseId = new Map(
    nodes.flatMap((node) => (node.kind === 'tool' ? [[node.toolUseId, node.id] as const] : [])),
  )
  const inputNodes = nodes
    .filter((node) => node.kind === 'user' || node.kind === 'context')
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  const firstAtOrAfter = (seq: number): number => {
    let low = 0
    let high = inputNodes.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if ((inputNodes[middle]?.seq ?? 0) < seq) low = middle + 1
      else high = middle
    }
    return low
  }
  for (const turn of turns) {
    if (!turn.trace) continue
    const origin = Date.parse(turn.trace.startedAt)
    if (!Number.isFinite(origin)) continue
    const selected = new Set<string>()
    const turnInputs: UINode[] = []
    for (const id of turn.nodeIds) {
      const node = nodeById.get(id)
      if (node && (node.kind === 'user' || node.kind === 'context') && !selected.has(node.id)) {
        selected.add(node.id)
        turnInputs.push(node)
      }
    }
    const start = firstAtOrAfter(turn.startSeq)
    const end = firstAtOrAfter((turn.endSeq ?? Number.POSITIVE_INFINITY) + 1)
    for (const node of inputNodes.slice(start, end)) {
      if (selected.has(node.id)) continue
      selected.add(node.id)
      turnInputs.push(node)
    }
    turnInputs.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    if (turnInputs.length === 0) {
      events.push({
        key: `input:${turn.id}`,
        lane: 'input',
        start: origin,
        end: origin,
        title: traceText('trace.gantt.turnInput', { turn: turn.turn }),
      })
    } else {
      turnInputs.forEach((node) => {
        events.push({
          key: `input:${turn.id}:${node.id}`,
          lane: 'input',
          tone: node.kind === 'user' ? 'user' : 'context',
          start: origin,
          end: origin,
          targetId: node.id,
          title: traceText('trace.gantt.anchored', {
            kind: traceText(node.kind === 'user' ? 'trace.badge.user' : 'trace.badge.context'),
          }),
        })
      })
    }
    walkSpans(turn.trace, (span) => {
      const at = Date.parse(span.startedAt)
      if (!Number.isFinite(at)) return
      const duration = span.durationMs ?? 0
      const targetId =
        span.nodeIds?.find((id) => rowNodeIds.has(id)) ??
        (span.toolUseId ? toolByUseId.get(span.toolUseId) : undefined)
      if (span.kind === 'generation')
        events.push({
          key: span.id,
          lane: 'model',
          start: at,
          end: at + duration,
          ...(targetId ? { targetId } : {}),
          title: `${span.model ?? span.name} · ${span.durationMs === undefined && span.status !== 'running' ? traceText('trace.duration.unknown') : durationLabel(span.durationMs)}`,
        })
      if (span.kind === 'tool')
        events.push({
          key: span.id,
          lane: 'tool',
          start: at,
          end: at + duration,
          ...(targetId ? { targetId } : {}),
          title: `${span.name} · ${span.durationMs === undefined && span.status !== 'running' ? traceText('trace.duration.unknown') : durationLabel(span.durationMs)}`,
        })
      if (isTruncation(span)) {
        const label = truncationLabel(span)
        events.push({ key: span.id, truncated: label, lane: 'tool', start: at, end: at, title: label })
      }
    })
  }
  // Span ids are unique in practice; a repeated one gets a suffix so each bar keeps its own key.
  const seen = new Map<string, number>()
  for (const event of events) {
    const count = seen.get(event.key) ?? 0
    seen.set(event.key, count + 1)
    if (count > 0) event.key = `${event.key}#${count}`
  }
  return projectTimedEvents(events, mode)
}

export const truncations = (
  turns: readonly UITurn[],
): Array<{ key: string; turn: number; label: string }> => {
  const found: Array<{ key: string; turn: number; label: string }> = []
  for (const turn of turns)
    if (turn.trace)
      walkSpans(turn.trace, (span) => {
        if (isTruncation(span)) found.push({ key: span.id, turn: turn.turn, label: truncationLabel(span) })
      })
  return found
}

export const traceStats = (turns: readonly UITurn[]): Array<[string, string]> => {
  let calls = 0
  let duration = 0
  for (const turn of turns) {
    duration += turn.durationMs ?? turn.trace?.durationMs ?? 0
    if (turn.trace)
      walkSpans(turn.trace, (span) => {
        if (span.kind === 'generation' || span.kind === 'tool') calls += 1
      })
  }
  return [
    [traceText('trace.stat.duration'), durationLabel(duration)],
    [traceText('trace.stat.turns'), String(turns.length)],
    [traceText('trace.stat.calls'), String(calls)],
  ]
}
