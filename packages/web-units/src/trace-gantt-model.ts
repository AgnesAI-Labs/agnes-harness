import type { UINode, UITurn } from '@agnes/protocol'
import { traceText } from './trace-locale.js'
import {
  clip,
  durationLabel,
  isTruncation,
  LIST_KINDS,
  type TraceRow,
  truncationLabel,
  walkSpans,
} from './trace-model.js'

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
