import type { ToolCall, ToolResult, UINode, UISpan, UITurn } from '@agnes/protocol'
import {
  createElement,
  type ForwardedRef,
  forwardRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { buildTraceToolHierarchy, isTraceRowHiddenByTool, traceToolAncestors } from './trace-hierarchy.js'
import {
  buildTraceRequestMetrics,
  type TraceMetric,
  type TraceTokenMetrics,
} from './trace-request-metrics.js'
import { buildTraceTimelineDensity, pickTraceTimelineDensityMember } from './trace-timeline-density.js'
import {
  buildTraceVirtualLayout,
  captureTraceVirtualAnchor,
  getTraceVirtualScrollTopForKey,
  getTraceVirtualWindow,
  restoreTraceVirtualAnchor,
  type TraceVirtualAnchor,
  type TraceVirtualLayout,
} from './trace-virtual-window.js'

export const TRACE_PANEL_STORAGE_KEY = 'agnes.web.tracePanel'

const BADGE: Record<string, string> = {
  user: '用户',
  context: '上下文',
  assistant: '助手',
  tool: '工具',
  approval: '审批',
  compaction: '整理',
  cost: '费用',
}

const STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  waiting: '等待中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  planned: '等待执行',
  awaiting_approval: '等待审批',
}

/** What the host knows beyond the loaded snapshot: whether older records exist, and how to load them. */
export type TraceMeta = { hasEarlier: boolean; loadEarlier?: () => void; sessionId?: string }

export type TraceHandle = {
  render(nodes: readonly UINode[], turns?: readonly UITurn[], meta?: TraceMeta): void
  setOpen(open: boolean): void
  isOpen(): boolean
}

export type TracePanel = TraceHandle

export type TracePanelOptions = {
  root: HTMLElement
  toggle: HTMLButtonElement
  chatToggle?: HTMLButtonElement
  conversation?: HTMLElement
  store?: Pick<Storage, 'getItem' | 'setItem'>
  readToolDetail?: (
    sessionId: string,
    callSeq: number,
    resultSeq?: number,
    signal?: AbortSignal,
  ) => Promise<{ call: ToolCall; result?: ToolResult }>
}

export type TraceRow = {
  id: string
  seq: number
  turn?: number | undefined
  step?: string | undefined
  badge: string
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

type GanttBar = {
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

type TimelineMode = 'sequence' | 'duration' | 'time' | 'actual'
type TimelineRange = { start: number; end: number }
type TraceListItem =
  | { key: 'load-earlier'; kind: 'header'; loadEarlier: () => void }
  | { key: string; kind: 'header'; turn: number; count: number; collapsed: boolean }
  | { key: string; kind: 'row'; row: TraceRow; showStep: boolean }

const TRACE_ROW_HEIGHT = 32
const TRACE_HEADER_HEIGHT = 33
const TRACE_VIRTUAL_THRESHOLD = 100

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`

export const durationLabel = (duration?: number): string => {
  if (duration === undefined) return '进行中'
  if (duration < 1000) return `${duration} 毫秒`
  if (duration < 60_000) return `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)} 秒`
  return `${Math.floor(duration / 60_000)} 分 ${Math.round((duration % 60_000) / 1000)} 秒`
}

const tokenLabel = (
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number },
  reasoningKnown: boolean,
): string =>
  `输入 ${tokens.input} · 输出 ${tokens.output} · 缓存读取 ${tokens.cacheRead} · 缓存写入 ${tokens.cacheWrite} · 推理 ${reasoningKnown ? tokens.reasoning : '未提供'}`

const metricLabel = (metric: TraceMetric<number>): string =>
  metric.state === 'known'
    ? String(metric.value)
    : metric.reason === 'earlier-history-unloaded'
      ? '更早历史未加载'
      : metric.reason === 'request-order-unverifiable'
        ? '无法核对'
        : '未记录'

const metricTokensLabel = (tokens: TraceTokenMetrics): string =>
  `输入 ${metricLabel(tokens.input)} · 输出 ${metricLabel(tokens.output)} · 缓存读取 ${metricLabel(tokens.cacheRead)} · 缓存写入 ${metricLabel(tokens.cacheWrite)} · 推理 ${metricLabel(tokens.reasoning)}`

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
    return [message, images ? `${images} 张图片` : '', resources ? `${resources} 个资源链接` : '']
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
    return [`工具：${node.name}`, node.argsPreview, node.resultPreview].filter(Boolean).join('\n\n')
  return nodePreview(node)
}

const userAttachments = (node: UINode): string[] => {
  if (node.kind !== 'user') return []
  return node.content.flatMap((block) => {
    if (block.type === 'image') return [`图片 · ${block.mimeType}`]
    if (block.type === 'resource_link')
      return [`资源链接 · ${block.name ?? '未命名资源'}${block.mimeType ? ` · ${block.mimeType}` : ''}`]
    return []
  })
}

const nodeSource = (node: UINode): string => {
  if (node.kind === 'user') return node.actorLabel ? `用户 · ${node.actorLabel}` : '用户'
  if (node.kind === 'assistant') return '模型'
  if (node.kind === 'tool') return `工具 · ${node.name}`
  if (node.kind === 'context') return '运行时上下文'
  if (node.kind === 'approval') return '审批'
  if (node.kind === 'compaction') return '上下文整理'
  return node.kind
}

const LIST_KINDS = new Set(['user', 'context', 'assistant', 'tool', 'approval', 'compaction'])

/** A span placed where the trace shortened a subtree; its message is how many steps it stands for. */
const isTruncation = (span: UISpan): boolean => span.error?.code === 'TRACE_TRUNCATED'
const truncationLabel = (span: UISpan): string => `已省略 ${span.error?.message ?? '若干'} 个子步骤`

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
const rowCache = new WeakMap<UINode, { turn: UITurn | undefined; span: UISpan | undefined; row: TraceRow }>()

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
    const status =
      node.kind === 'tool'
        ? (STATUS_LABEL[node.status] ?? node.status)
        : (STATUS_LABEL[span?.status ?? ''] ?? '已完成')
    const errorCode = span && !isTruncation(span) ? span.error?.code : undefined
    const usage = turn?.usage?.calls.length ? turn.usage : undefined
    const callUsage =
      span?.callSeq === undefined
        ? undefined
        : turn?.usage?.calls.find((call) => call.seq === span.callSeq && !call.adjustment)
    const cached = rowCache.get(node)
    if (
      cached &&
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
      cached.row.callUsage === callUsage
    ) {
      rows.push(cached.row)
      continue
    }
    const row: TraceRow = {
      id: node.id,
      seq: node.seq,
      turn: turn?.turn,
      step: placed?.step,
      badge: BADGE[node.kind] ?? node.kind,
      preview,
      raw,
      ...(node.kind === 'tool' ? { rawNote: '工具参数与结果来自有长度限制的会话投影，可能已截断。' } : {}),
      ...(attachments.length ? { attachments, rawNote: '附件只显示摘要；内容请在对话中查看。' } : {}),
      source: nodeSource(node),
      status,
      startedAt: span?.startedAt,
      durationMs: span?.durationMs,
      ttftMs: span?.ttftMs,
      model: span?.model,
      errorCode,
      usage,
      callUsage,
    }
    rowCache.set(node, { turn, span, row })
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

function buildGantt(
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
          row.badge === '用户' || row.badge === '上下文' ? 'input' : row.badge === '工具' ? 'tool' : 'model',
        ...(row.badge === '用户' ? { tone: 'user' as const } : {}),
        ...(row.badge === '上下文' ? { tone: 'context' as const } : {}),
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
        title: `第 ${turn.turn} 轮输入 · 按轮次起点定位`,
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
          title: `${node.kind === 'user' ? '用户' : '上下文'} · 按轮次起点定位`,
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
          title: `${span.model ?? span.name} · ${span.durationMs === undefined && span.status !== 'running' ? '时长未知' : durationLabel(span.durationMs)}`,
        })
      if (span.kind === 'tool')
        events.push({
          key: span.id,
          lane: 'tool',
          start: at,
          end: at + duration,
          ...(targetId ? { targetId } : {}),
          title: `${span.name} · ${span.durationMs === undefined && span.status !== 'running' ? '时长未知' : durationLabel(span.durationMs)}`,
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

export interface TraceProps {
  root: HTMLElement
  options: Omit<TracePanelOptions, 'root'>
}

const truncations = (turns: readonly UITurn[]): Array<{ key: string; turn: number; label: string }> => {
  const found: Array<{ key: string; turn: number; label: string }> = []
  for (const turn of turns)
    if (turn.trace)
      walkSpans(turn.trace, (span) => {
        if (isTruncation(span)) found.push({ key: span.id, turn: turn.turn, label: truncationLabel(span) })
      })
  return found
}

const traceStats = (turns: readonly UITurn[]): Array<[string, string]> => {
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
    ['时长', durationLabel(duration)],
    ['轮次', String(turns.length)],
    ['调用', String(calls)],
  ]
}

const INSPECTOR_PANES = [
  ['overview', '概述'],
  ['preview', '预览'],
  ['raw', '投影内容'],
  ['source', '来源'],
] as const

type InspectorPane = (typeof INSPECTOR_PANES)[number][0] | 'input' | 'output' | 'timing'
type ToolDetail = { call: ToolCall; result?: ToolResult }
type ToolDetailState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'error'; message: string }
  | { key: string; status: 'ready'; value: ToolDetail }

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50
const orderedRange = (a: number, b: number): TimelineRange =>
  a <= b ? { start: a, end: b } : { start: b, end: a }
const barIntersectsRange = (bar: GanttBar, range: TimelineRange): boolean =>
  bar.marker
    ? bar.domainStart >= range.start && bar.domainStart <= range.end
    : bar.domainStart < range.end && bar.domainEnd > range.start

/**
 * The built-in trace unit owns all of its markup and state in React.  The host
 * only supplies the outer visibility surface and the imperative data/view
 * contract, so a slot replacement can mount without inheriting this DOM.
 */
export const Trace = forwardRef<TraceHandle, TraceProps>(function Trace(
  { root, options }: TraceProps,
  ref: ForwardedRef<TraceHandle>,
) {
  const store = options.store ?? sessionStorage
  const open = useRef(store.getItem(TRACE_PANEL_STORAGE_KEY) === 'open')
  type Snapshot = { nodes: readonly UINode[]; turns: readonly UITurn[]; meta?: TraceMeta | undefined }
  const [snapshot, setSnapshot] = useState<Snapshot>({ nodes: [], turns: [] })
  // While the panel is closed, render() only remembers the newest snapshot; opening shows it.
  const latest = useRef<Snapshot | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [pane, setPane] = useState<InspectorPane>('overview')
  const [toolDetail, setToolDetail] = useState<ToolDetailState | undefined>(undefined)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  useEffect(() => {
    if (!lightbox) return
    const previousFocus = document.activeElement
    root.querySelector<HTMLButtonElement>('.trace-lightbox-close')?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [lightbox, root])
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set())
  const [collapsedTools, setCollapsedTools] = useState<ReadonlySet<string>>(new Set())
  const [timelineMode, setTimelineMode] = useState<TimelineMode>('duration')
  const [timelineRange, setTimelineRange] = useState<TimelineRange | null>(null)
  const [timelineDraft, setTimelineDraft] = useState<TimelineRange | null>(null)
  const [timelineViewport, setTimelineViewport] = useState<TimelineRange | null>(null)
  const [listScrollTop, setListScrollTop] = useState(0)
  const [listViewportHeight, setListViewportHeight] = useState(480)
  const listViewportHeightRef = useRef(listViewportHeight)
  listViewportHeightRef.current = listViewportHeight
  const listRef = useRef<HTMLDivElement | null>(null)
  const layoutRef = useRef<TraceVirtualLayout<TraceListItem> | null>(null)
  const pendingListPosition = useRef<{ anchor: TraceVirtualAnchor | undefined; followTail: boolean } | null>(
    null,
  )
  const earlierPosition = useRef<{
    sessionId: string | undefined
    firstNodeId: string | undefined
    anchor: TraceVirtualAnchor | undefined
  } | null>(null)
  const renderedSessionId = useRef<string | undefined>(undefined)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const timelineTrackRef = useRef<HTMLDivElement | null>(null)
  const timelineGesture = useRef<{
    pointerId: number
    clientX: number
    anchor: number
    pan: boolean
    viewportStart: number
  } | null>(null)
  const rows = useMemo(
    () => traceRowBuilder.build(snapshot.nodes, snapshot.turns),
    [snapshot.nodes, snapshot.turns],
  )
  const toolHierarchy = useMemo(() => buildTraceToolHierarchy(snapshot.nodes), [snapshot.nodes])
  const selectedRow = selected ? rows.find((row) => row.id === selected) : undefined
  const requestMetrics = useMemo(
    () => buildTraceRequestMetrics(snapshot.turns, { hasEarlier: Boolean(snapshot.meta?.hasEarlier) }),
    [snapshot.turns, snapshot.meta?.hasEarlier],
  )
  const selectedRequest = selectedRow?.callUsage ? requestMetrics.get(selectedRow.callUsage.seq) : undefined
  const selectedUserNode = selected
    ? snapshot.nodes.find((node) => node.id === selected && node.kind === 'user')
    : undefined
  const selectedToolNode = selected
    ? snapshot.nodes.find((node) => node.id === selected && node.kind === 'tool')
    : undefined
  const selectedToolCallSeq = selectedToolNode?.seq
  const selectedToolResultSeq = selectedToolNode?.kind === 'tool' ? selectedToolNode.resultSeq : undefined
  const selectedToolKey =
    selectedToolNode && options.readToolDetail && snapshot.meta?.sessionId
      ? `${snapshot.meta?.sessionId ?? ''}:${selectedToolNode.id}:${selectedToolCallSeq}:${selectedToolResultSeq ?? ''}`
      : undefined
  const activeToolDetail = toolDetail?.key === selectedToolKey ? toolDetail : undefined
  const wantsToolDetail = pane === 'input' || pane === 'output'
  useEffect(() => {
    const sessionId = snapshot.meta?.sessionId
    if (
      !wantsToolDetail ||
      selectedToolKey === undefined ||
      selectedToolCallSeq === undefined ||
      !sessionId ||
      !options.readToolDetail
    )
      return
    let active = true
    const controller = new AbortController()
    setToolDetail({ key: selectedToolKey, status: 'loading' })
    void options
      .readToolDetail(sessionId, selectedToolCallSeq, selectedToolResultSeq, controller.signal)
      .then(
        (value) => {
          if (active) setToolDetail({ key: selectedToolKey, status: 'ready', value })
        },
        (error: unknown) => {
          if (active)
            setToolDetail({
              key: selectedToolKey,
              status: 'error',
              message: error instanceof Error ? error.message : String(error),
            })
        },
      )
    return () => {
      active = false
      controller.abort()
    }
  }, [
    options.readToolDetail,
    selectedToolKey,
    selectedToolCallSeq,
    selectedToolResultSeq,
    snapshot.meta?.sessionId,
    wantsToolDetail,
  ])
  const numberedTurns = [...new Set(rows.flatMap((row) => (row.turn === undefined ? [] : [row.turn])))]
  const allTurnsCollapsed =
    numberedTurns.length > 0 && numberedTurns.every((turn) => collapsedTurns.has(turn))

  const applyOpen = (next: boolean, persist: boolean): void => {
    open.current = next
    const pending = latest.current
    if (next && pending) {
      latest.current = undefined
      pendingListPosition.current = { anchor: undefined, followTail: true }
      flushSync(() => {
        if (renderedSessionId.current !== pending.meta?.sessionId) {
          renderedSessionId.current = pending.meta?.sessionId
          setSelected(undefined)
          setLightbox(null)
          setQuery('')
          setTimelineRange(null)
          setTimelineViewport(null)
          setCollapsedTurns(new Set())
          setCollapsedTools(new Set())
        }
        setSnapshot(pending)
      })
    }
    root.hidden = !next
    document.body.classList.toggle('trace-open', next)
    options.toggle.setAttribute('aria-pressed', next ? 'true' : 'false')
    options.toggle.setAttribute('aria-selected', next ? 'true' : 'false')
    if (options.chatToggle) {
      options.chatToggle.setAttribute('aria-selected', next ? 'false' : 'true')
      options.chatToggle.setAttribute('aria-pressed', next ? 'false' : 'true')
    }
    if (options.conversation) options.conversation.hidden = next
    if (persist) store.setItem(TRACE_PANEL_STORAGE_KEY, next ? 'open' : 'closed')
  }

  const applyOpenRef = useRef(applyOpen)
  applyOpenRef.current = applyOpen
  useLayoutEffect(() => {
    const openTrace = () => applyOpenRef.current(true, true)
    const openChat = () => applyOpenRef.current(false, true)
    options.toggle.addEventListener('click', openTrace)
    options.chatToggle?.addEventListener('click', openChat)
    applyOpenRef.current(open.current, false)
    return () => {
      options.toggle.removeEventListener('click', openTrace)
      options.chatToggle?.removeEventListener('click', openChat)
      document.body.classList.remove('trace-open')
    }
  }, [options.chatToggle, options.toggle])

  useImperativeHandle(
    ref,
    () => ({
      render(nodes, turns = [], meta) {
        if (!open.current) {
          latest.current = { nodes, turns, meta }
          return
        }
        const list = listRef.current
        const layout = layoutRef.current
        const switchingSession = renderedSessionId.current !== meta?.sessionId
        const earlier = earlierPosition.current
        const olderLoaded =
          earlier && earlier.sessionId === meta?.sessionId && earlier.firstNodeId !== nodes[0]?.id
        if (switchingSession) {
          earlierPosition.current = null
          pendingListPosition.current = { anchor: undefined, followTail: true }
        } else if (olderLoaded) {
          earlierPosition.current = null
          pendingListPosition.current = { anchor: earlier.anchor, followTail: false }
        } else if (list && layout) {
          const viewportHeight = list.clientHeight || listViewportHeightRef.current
          pendingListPosition.current = {
            anchor: captureTraceVirtualAnchor(layout, list.scrollTop),
            followTail:
              layout.entries.length === 0 || list.scrollTop + viewportHeight >= layout.totalHeight - 48,
          }
        }
        flushSync(() => {
          if (renderedSessionId.current !== meta?.sessionId) {
            renderedSessionId.current = meta?.sessionId
            setSelected(undefined)
            setLightbox(null)
            setQuery('')
            setTimelineRange(null)
            setTimelineViewport(null)
            setCollapsedTurns(new Set())
            setCollapsedTools(new Set())
          }
          if (olderLoaded) {
            setTimelineRange(null)
            setTimelineViewport(null)
          }
          setSnapshot({ nodes, turns, meta })
          if (nodes.length === 0) {
            setCollapsedTurns(new Set())
            setCollapsedTools(new Set())
          }
          setSelected((current) =>
            current && nodes.some((node) => node.id === current) ? current : undefined,
          )
        })
      },
      setOpen(next) {
        applyOpenRef.current(next, true)
      },
      isOpen() {
        return open.current
      },
    }),
    [],
  )

  const timelineModel = useMemo(
    () => buildGantt(snapshot.turns, snapshot.nodes, rows, timelineMode),
    [snapshot.turns, snapshot.nodes, rows, timelineMode],
  )
  const bars = timelineModel.bars
  const fullTimelineWidth = timelineModel.end - timelineModel.start
  const viewportWidth = Math.min(
    fullTimelineWidth,
    timelineViewport ? timelineViewport.end - timelineViewport.start : fullTimelineWidth,
  )
  const viewportStart = timelineViewport
    ? Math.max(timelineModel.start, Math.min(timelineModel.end - viewportWidth, timelineViewport.start))
    : timelineModel.start
  const viewportEnd = viewportStart + viewportWidth
  const selectedBarKey = useMemo(() => bars.find((bar) => bar.targetId === selected)?.key, [bars, selected])
  const visibleTimelineBars = useMemo(
    () => bars.filter((bar) => bar.domainStart <= viewportEnd && bar.domainEnd >= viewportStart),
    [bars, viewportStart, viewportEnd],
  )
  const timelineUnits = useMemo(
    () =>
      buildTraceTimelineDensity(visibleTimelineBars, selectedBarKey ? { selectedKey: selectedBarKey } : {}),
    [visibleTimelineBars, selectedBarKey],
  )
  const rangeIds = useMemo(
    () =>
      timelineRange && !(timelineRange.start <= timelineModel.start && timelineRange.end >= timelineModel.end)
        ? new Set(
            bars
              .filter((bar) => bar.targetId && barIntersectsRange(bar, timelineRange))
              .map((bar) => bar.targetId),
          )
        : null,
    [bars, timelineRange, timelineModel.start, timelineModel.end],
  )
  const visibleRows = useMemo(
    () =>
      rows.filter((row) => {
        if (rangeIds && !rangeIds.has(row.id)) return false
        if (!query && !timelineRange && isTraceRowHiddenByTool(toolHierarchy, row.id, collapsedTools))
          return false
        if (!query) return true
        const hay =
          `${row.badge} ${row.step ?? ''} ${row.preview} ${row.raw} ${row.source} ${row.errorCode ?? ''}`.toLowerCase()
        return hay.includes(query)
      }),
    [rows, rangeIds, query, timelineRange, toolHierarchy, collapsedTools],
  )
  const groups = useMemo(() => {
    const result: Array<{ turn: number | undefined; rows: TraceRow[] }> = []
    for (const row of visibleRows) {
      const previous = result[result.length - 1]
      if (previous && previous.turn === row.turn) previous.rows.push(row)
      else result.push({ turn: row.turn, rows: [row] })
    }
    return result
  }, [visibleRows])
  const focusActive = Boolean(query || timelineRange)
  const listItems = useMemo(() => {
    const items: TraceListItem[] = []
    if (snapshot.meta?.hasEarlier && snapshot.meta.loadEarlier)
      items.push({ key: 'load-earlier', kind: 'header', loadEarlier: snapshot.meta.loadEarlier })
    for (const group of groups) {
      if (group.turn !== undefined)
        items.push({
          key: `turn:${group.rows[0]?.id}`,
          kind: 'header',
          turn: group.turn,
          count: group.rows.length,
          collapsed: collapsedTurns.has(group.turn) && !focusActive,
        })
      if (group.turn !== undefined && collapsedTurns.has(group.turn) && !focusActive) continue
      for (const [index, row] of group.rows.entries())
        items.push({
          key: `row:${row.id}`,
          kind: 'row',
          row,
          showStep: row.step !== undefined && (index === 0 || group.rows[index - 1]?.step !== row.step),
        })
    }
    return items
  }, [groups, collapsedTurns, focusActive, snapshot.meta])
  const listLayout = useMemo(
    () => buildTraceVirtualLayout(listItems, { header: TRACE_HEADER_HEIGHT, row: TRACE_ROW_HEIGHT }),
    [listItems],
  )
  layoutRef.current = listLayout
  const virtualized = listItems.length > TRACE_VIRTUAL_THRESHOLD
  const listWindow = virtualized
    ? getTraceVirtualWindow(listLayout, listScrollTop, listViewportHeight, 256)
    : { start: 0, end: listItems.length, topPadding: 0, bottomPadding: 0 }
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const pending = pendingListPosition.current
    pendingListPosition.current = null
    if (pending) {
      list.scrollTop = pending.followTail
        ? Math.max(0, listLayout.totalHeight - (list.clientHeight || listViewportHeightRef.current))
        : restoreTraceVirtualAnchor(
            listLayout,
            pending.anchor,
            list.scrollTop,
            list.clientHeight || listViewportHeightRef.current,
          )
    }
    setListScrollTop(list.scrollTop)
  }, [listLayout])
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = (): void => setListViewportHeight(list.clientHeight || 480)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [])
  const omitted = useMemo(() => truncations(snapshot.turns), [snapshot.turns])
  const meta = snapshot.meta
  const selectRow = (id: string): void => {
    const bar = timelineViewport ? bars.find((item) => item.targetId === id) : undefined
    const revealBar = bar && (bar.domainStart > viewportEnd || bar.domainEnd < viewportStart)
    flushSync(() => {
      if (!visibleRows.some((row) => row.id === id)) {
        setQuery('')
        setTimelineRange(null)
      }
      const turn = rows.find((row) => row.id === id)?.turn
      if (turn !== undefined && collapsedTurns.has(turn)) {
        setCollapsedTurns((current) => new Set([...current].filter((value) => value !== turn)))
      }
      const ancestors = traceToolAncestors(toolHierarchy, id)
      if (ancestors.some((ancestor) => collapsedTools.has(ancestor)))
        setCollapsedTools((current) => new Set([...current].filter((value) => !ancestors.includes(value))))
      setSelected(id)
      if (revealBar) {
        const start = Math.max(
          timelineModel.start,
          Math.min(timelineModel.end - viewportWidth, bar.domainStart - viewportWidth / 2),
        )
        setTimelineViewport({ start, end: start + viewportWidth })
      }
      setLightbox(null)
      setPane('overview')
    })
    const list = listRef.current
    const layout = layoutRef.current
    if (list && layout && layout.entries.length > TRACE_VIRTUAL_THRESHOLD) {
      const position = getTraceVirtualScrollTopForKey(
        layout,
        `row:${id}`,
        list.scrollTop,
        list.clientHeight || listViewportHeight,
      )
      if (position !== undefined) {
        list.scrollTop = position
        flushSync(() => setListScrollTop(position))
      }
    }
    const target = [...root.querySelectorAll<HTMLButtonElement>('.trace-row')].find(
      (row) => row.dataset.traceRowId === id,
    )
    target?.scrollIntoView?.({ block: 'nearest' })
  }
  const closeInspector = (): void =>
    flushSync(() => {
      setSelected(undefined)
      setLightbox(null)
    })
  const selectPane = (next: InspectorPane): void => flushSync(() => setPane(next))
  const toggleTurn = (turn: number): void =>
    flushSync(() =>
      setCollapsedTurns((current) => {
        const next = new Set(current)
        if (next.has(turn)) next.delete(turn)
        else next.add(turn)
        return next
      }),
    )
  const toggleTool = (id: string): void =>
    flushSync(() =>
      setCollapsedTools((current) => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    )
  const toggleAllTurns = (): void =>
    flushSync(() => setCollapsedTurns(allTurnsCollapsed ? new Set() : new Set(numberedTurns)))
  const updateQuery = (event: { currentTarget: HTMLInputElement }): void =>
    flushSync(() => setQuery(event.currentTarget.value.trim().toLowerCase()))
  const changeTimelineMode = (event: { currentTarget: HTMLSelectElement }): void => {
    setTimelineMode(event.currentTarget.value as TimelineMode)
    setTimelineRange(null)
    setTimelineDraft(null)
    setTimelineViewport(null)
  }
  const timelinePoint = (event: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = clampPercent(((event.clientX - rect.left) / Math.max(1, rect.width)) * 100)
    return viewportStart + (fraction / 100) * viewportWidth
  }
  const timelinePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.button !== 2) return
    if (event.button === 0 && (event.target as HTMLElement).closest('button')) return
    const anchor = timelinePoint(event)
    timelineGesture.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      anchor,
      pan: event.button === 2,
      viewportStart,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    if (event.button === 0) setTimelineDraft({ start: anchor, end: anchor })
  }
  const timelinePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const gesture = timelineGesture.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (gesture.pan) {
      const rect = event.currentTarget.getBoundingClientRect()
      const width = viewportWidth
      const shift = ((event.clientX - gesture.clientX) / Math.max(1, rect.width)) * width
      const start = Math.max(
        timelineModel.start,
        Math.min(timelineModel.end - width, gesture.viewportStart - shift),
      )
      setTimelineViewport({ start, end: start + width })
      return
    }
    setTimelineDraft(orderedRange(gesture.anchor, timelinePoint(event)))
  }
  const timelinePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const gesture = timelineGesture.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    timelineGesture.current = null
    setTimelineDraft(null)
    const distance = Math.abs(event.clientX - gesture.clientX)
    if (gesture.pan) {
      if (distance < 3) setTimelineRange(null)
      return
    }
    const point = timelinePoint(event)
    const selectedRange = orderedRange(gesture.anchor, point)
    const minimum = Math.min(
      viewportWidth,
      Math.max(fullTimelineWidth * 0.005, fullTimelineWidth / Math.max(1, bars.length)),
    )
    if (selectedRange.end - selectedRange.start < minimum) {
      const center = distance < 3 ? selectedRange.start : (selectedRange.start + selectedRange.end) / 2
      const start = Math.max(timelineModel.start, Math.min(timelineModel.end - minimum, center - minimum / 2))
      selectedRange.start = start
      selectedRange.end = start + minimum
    }
    if (distance < 3 && bars.length) {
      const nearest = bars.reduce((best, bar) => {
        const gap = (candidate: GanttBar): number =>
          point < candidate.domainStart
            ? candidate.domainStart - point
            : point > candidate.domainEnd
              ? point - candidate.domainEnd
              : 0
        return gap(bar) < gap(best) ? bar : best
      })
      if (nearest.targetId) {
        selectRow(nearest.targetId)
        if (!barIntersectsRange(nearest, selectedRange)) {
          const center = (nearest.domainStart + nearest.domainEnd) / 2
          const start = Math.max(
            timelineModel.start,
            Math.min(timelineModel.end - minimum, center - minimum / 2),
          )
          selectedRange.start = start
          selectedRange.end = start + minimum
        }
      }
    }
    setTimelineRange(selectedRange)
  }
  const timelinePointerCancel = (): void => {
    timelineGesture.current = null
    setTimelineDraft(null)
  }
  useEffect(() => {
    const element = timelineRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      const track = timelineTrackRef.current
      if (!track || bars.length === 0) return
      event.preventDefault()
      const rect = track.getBoundingClientRect()
      const fraction = clampPercent(((event.clientX - rect.left) / Math.max(1, rect.width)) * 100) / 100
      setTimelineViewport((current) => {
        const width = current ? current.end - current.start : fullTimelineWidth
        const oldStart = current?.start ?? timelineModel.start
        const minimum = Math.min(fullTimelineWidth, fullTimelineWidth / Math.max(2, bars.length))
        const nextWidth = Math.max(
          minimum,
          Math.min(fullTimelineWidth, width * Math.exp(event.deltaY * 0.0015)),
        )
        if (nextWidth >= fullTimelineWidth * 0.999) return null
        const anchor = oldStart + fraction * width
        const start = Math.max(
          timelineModel.start,
          Math.min(timelineModel.end - nextWidth, anchor - fraction * nextWidth),
        )
        return { start, end: start + nextWidth }
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [bars.length, fullTimelineWidth, timelineModel.start, timelineModel.end])
  const activeTimelineRange = timelineDraft ?? timelineRange
  const projectedPosition = (value: number): number => ((value - viewportStart) / viewportWidth) * 100
  const paneField = (label: string, value: string) =>
    createElement(
      'div',
      { className: 'trace-field', key: label },
      createElement('div', { className: 'trace-field-label' }, label),
      createElement('div', { className: 'trace-field-value' }, value),
    )
  const inspectorPanes: readonly (readonly [InspectorPane, string])[] = selectedToolKey
    ? [...INSPECTOR_PANES, ['input', '完整输入'], ['output', '完整输出'], ['timing', '时间']]
    : INSPECTOR_PANES
  const detailValue = activeToolDetail?.status === 'ready' ? activeToolDetail.value : undefined
  const detailNotice = () =>
    activeToolDetail?.status === 'error'
      ? createElement(
          'p',
          { className: 'trace-detail-status', role: 'alert' },
          `读取详情失败：${activeToolDetail.message}`,
        )
      : createElement(
          'p',
          { className: 'trace-detail-status', role: 'status' },
          activeToolDetail?.status === 'loading' ? '正在读取完整记录…' : '尚无可读取的详情',
        )
  const copyDetail = (label: string, value: string) =>
    createElement(
      'button',
      {
        type: 'button',
        className: 'trace-detail-copy',
        disabled: !navigator.clipboard?.writeText,
        onClick: () => void navigator.clipboard.writeText(value),
      },
      label,
    )
  const toolResultBlocks = (result: ToolResult) =>
    result.content.map((block, index) => {
      if (block.type === 'text')
        return createElement(
          'pre',
          { className: 'trace-pre trace-detail-content', key: `text:${index}` },
          block.text,
        )
      if (block.type === 'image') {
        const supported = /^image\/(png|jpeg|webp|gif)$/.test(block.mimeType)
        const src = supported ? `data:${block.mimeType};base64,${block.data}` : undefined
        return createElement(
          'div',
          { className: 'trace-detail-media', key: `image:${index}` },
          src
            ? createElement(
                'button',
                {
                  type: 'button',
                  className: 'trace-image-thumb',
                  'aria-label': `查看结果图片 ${index + 1}`,
                  onClick: () => setLightbox({ src, alt: `工具结果图片 ${index + 1}` }),
                },
                createElement('img', { src, alt: `工具结果图片 ${index + 1}` }),
              )
            : `图片 · ${block.mimeType}`,
        )
      }
      return createElement(
        'p',
        { className: 'trace-detail-resource', key: `resource:${index}` },
        `资源链接 · ${block.name ?? block.uri}${block.mimeType ? ` · ${block.mimeType}` : ''}`,
      )
    })
  const inspector = selectedRow
    ? createElement(
        'aside',
        { className: 'trace-inspector' },
        createElement(
          'header',
          { className: 'trace-inspector-head' },
          createElement('span', { className: `trace-badge kind-${selectedRow.badge}` }, selectedRow.badge),
          createElement(
            'h2',
            { className: 'trace-inspector-title' },
            [selectedRow.turn ? `第 ${selectedRow.turn} 轮` : undefined, selectedRow.step, '消息']
              .filter(Boolean)
              .join(' · '),
          ),
          createElement(
            'button',
            {
              className: 'trace-inspector-close',
              type: 'button',
              'aria-label': '关闭详情',
              onClick: closeInspector,
            },
            '×',
          ),
        ),
        createElement(
          'div',
          { className: 'trace-inspector-tabs' },
          ...inspectorPanes.map(([id, label]) =>
            createElement(
              'button',
              {
                key: id,
                className: 'trace-tab',
                type: 'button',
                'data-pane': id,
                'aria-selected': pane === id ? 'true' : 'false',
                onClick: () => selectPane(id),
              },
              label,
            ),
          ),
        ),
        createElement(
          'div',
          { className: 'trace-inspector-pane', hidden: pane !== 'overview' },
          paneField('来源', selectedRow.source),
          paneField('状态', selectedRow.status),
          ...(selectedRow.errorCode ? [paneField('错误码', selectedRow.errorCode)] : []),
          ...(selectedRow.attachments?.length ? [paneField('附件', selectedRow.attachments.join('；'))] : []),
          ...(selectedUserNode?.kind === 'user'
            ? selectedUserNode.content.flatMap((block, index) => {
                if (block.type !== 'image' || !/^image\/(png|jpeg|webp|gif)$/.test(block.mimeType)) return []
                const src = `data:${block.mimeType};base64,${block.data}`
                return [
                  createElement(
                    'button',
                    {
                      key: `user-image:${index}`,
                      className: 'trace-image-thumb',
                      type: 'button',
                      'aria-label': `查看输入图片 ${index + 1}`,
                      onClick: () => setLightbox({ src, alt: `输入图片 ${index + 1}` }),
                    },
                    createElement('img', { src, alt: `输入图片 ${index + 1}` }),
                  ),
                ]
              })
            : []),
          ...(selectedRow.step ? [paneField('步骤', selectedRow.step)] : []),
          ...(selectedRow.durationMs !== undefined || selectedRow.status === '进行中'
            ? [paneField('时长', durationLabel(selectedRow.durationMs))]
            : []),
          ...(selectedRow.ttftMs === undefined ? [] : [paneField('首字', durationLabel(selectedRow.ttftMs))]),
          ...(selectedRow.model === undefined ? [] : [paneField('模型', selectedRow.model)]),
          ...(selectedRow.usage === undefined
            ? []
            : [
                paneField(
                  '本轮用量',
                  tokenLabel(selectedRow.usage.totals, selectedRow.usage.reasoningComplete),
                ),
              ]),
          ...(selectedRow.callUsage?.tokens
            ? [
                paneField(
                  '当前调用',
                  tokenLabel(
                    selectedRow.callUsage.tokens,
                    selectedRow.callUsage.tokens.reasoning !== undefined,
                  ),
                ),
              ]
            : []),
          ...(selectedRequest
            ? [
                paneField('请求顺序', metricLabel(selectedRequest.requestNumber)),
                paneField('入账顺序', metricLabel(selectedRequest.ledgerNumber)),
                paneField('累计入账用量', metricTokensLabel(selectedRequest.cumulativeTokens)),
                paneField(
                  '当次耗时',
                  selectedRequest.durationMs.state === 'known'
                    ? durationLabel(selectedRequest.durationMs.value)
                    : metricLabel(selectedRequest.durationMs),
                ),
                paneField(
                  '累计调用耗时',
                  selectedRequest.cumulativeCallDurationMs.state === 'known'
                    ? durationLabel(selectedRequest.cumulativeCallDurationMs.value)
                    : metricLabel(selectedRequest.cumulativeCallDurationMs),
                ),
              ]
            : []),
        ),
        createElement(
          'div',
          { className: 'trace-inspector-pane', hidden: pane !== 'preview' },
          createElement('pre', { className: 'trace-pre' }, selectedRow.preview || '（无预览）'),
        ),
        createElement(
          'div',
          { className: 'trace-inspector-pane', hidden: pane !== 'raw' },
          ...(selectedRow.rawNote
            ? [createElement('p', { className: 'trace-raw-note' }, selectedRow.rawNote)]
            : []),
          createElement('pre', { className: 'trace-pre' }, selectedRow.raw || '（无原始内容）'),
        ),
        createElement(
          'div',
          { className: 'trace-inspector-pane', hidden: pane !== 'source' },
          paneField('来源', selectedRow.source),
        ),
        ...(selectedToolKey
          ? [
              createElement(
                'div',
                { className: 'trace-inspector-pane', hidden: pane !== 'input' },
                ...(pane !== 'input'
                  ? []
                  : detailValue
                    ? [
                        copyDetail('复制输入 JSON', JSON.stringify(detailValue.call.args)),
                        createElement(
                          'pre',
                          { className: 'trace-pre trace-detail-content' },
                          JSON.stringify(detailValue.call.args, null, 2),
                        ),
                      ]
                    : [detailNotice()]),
              ),
              createElement(
                'div',
                { className: 'trace-inspector-pane', hidden: pane !== 'output' },
                ...(pane !== 'output'
                  ? []
                  : !detailValue
                    ? [detailNotice()]
                    : !detailValue.result
                      ? [createElement('p', { className: 'trace-detail-status' }, '工具结果尚未记录。')]
                      : [
                          paneField('结果', detailValue.result.isError ? '失败' : '完成'),
                          ...(detailValue.result.code ? [paneField('错误码', detailValue.result.code)] : []),
                          copyDetail('复制结果 JSON', JSON.stringify(detailValue.result)),
                          ...toolResultBlocks(detailValue.result),
                          ...(detailValue.result.structured === undefined
                            ? []
                            : [
                                createElement('h3', { className: 'trace-detail-heading' }, '结构化结果'),
                                createElement(
                                  'pre',
                                  { className: 'trace-pre trace-detail-content' },
                                  JSON.stringify(detailValue.result.structured, null, 2),
                                ),
                              ]),
                        ]),
              ),
              createElement(
                'div',
                { className: 'trace-inspector-pane', hidden: pane !== 'timing' },
                ...(selectedRow.startedAt ? [paneField('开始时间', selectedRow.startedAt)] : []),
                paneField(
                  '时长',
                  selectedRow.durationMs === undefined && selectedRow.status !== '进行中'
                    ? '时长未知'
                    : durationLabel(selectedRow.durationMs),
                ),
                ...(selectedRow.ttftMs === undefined
                  ? []
                  : [paneField('首字耗时', durationLabel(selectedRow.ttftMs))]),
                ...(selectedRow.ttftMs === undefined || selectedRow.durationMs === undefined
                  ? []
                  : [
                      paneField(
                        '后续生成',
                        durationLabel(Math.max(0, selectedRow.durationMs - selectedRow.ttftMs)),
                      ),
                    ]),
              ),
            ]
          : []),
      )
    : createElement('aside', { className: 'trace-inspector', hidden: true })

  return createElement(
    'div',
    {
      id: 'trace-content',
      style: { display: 'contents' },
      'data-agnes-region-owner': 'builtin',
      'data-agnes-region-unit': 'trace',
    },
    createElement(
      'div',
      { className: 'trace-toolbar', hidden: rows.length === 0 },
      createElement(
        'div',
        { className: 'trace-stats' },
        ...traceStats(snapshot.turns).map(([label, value]) =>
          createElement('span', { className: 'trace-stat', key: label }, `${label} ${value}`),
        ),
        ...(meta?.hasEarlier
          ? [createElement('span', { className: 'trace-stat trace-partial', key: 'partial' }, '已加载部分')]
          : []),
      ),
      createElement(
        'button',
        {
          className: 'trace-fold-all',
          type: 'button',
          disabled: focusActive || numberedTurns.length === 0,
          'aria-label': allTurnsCollapsed ? '展开所有轮次' : '折叠所有轮次',
          onClick: toggleAllTurns,
        },
        allTurnsCollapsed ? '展开轮次' : '折叠轮次',
      ),
      createElement('input', {
        className: 'trace-search',
        type: 'search',
        placeholder: '搜索',
        'aria-label': '搜索轨迹',
        value: query,
        onInput: updateQuery,
      }),
    ),
    createElement(
      'div',
      {
        className: 'trace-gantt',
        role: 'group',
        'aria-label': '轨迹时间图',
        hidden: rows.length === 0,
        ref: timelineRef,
      },
      createElement(
        'div',
        { className: 'trace-gantt-controls' },
        createElement('label', { htmlFor: 'trace-timeline-mode' }, '时间轴'),
        createElement(
          'select',
          {
            id: 'trace-timeline-mode',
            value: timelineMode,
            onChange: changeTimelineMode,
            'aria-label': '时间轴模式',
          },
          createElement('option', { value: 'sequence' }, '记录顺序'),
          createElement('option', { value: 'duration' }, '耗时 · 压缩空闲'),
          createElement('option', { value: 'time' }, '记录时间'),
          createElement('option', { value: 'actual' }, '实际耗时'),
        ),
        createElement(
          'span',
          { className: 'trace-gantt-note' },
          timelineMode === 'sequence'
            ? '按记录顺序等宽展示'
            : timelineMode === 'duration'
              ? '长空闲间隔已压缩；输入按轮次起点定位'
              : '按记录时间展示；输入按轮次起点定位',
        ),
        ...(timelineRange
          ? [
              createElement(
                'button',
                {
                  className: 'trace-gantt-clear',
                  type: 'button',
                  onClick: () => setTimelineRange(null),
                  'aria-label': '清除时间范围',
                },
                '清除范围',
              ),
            ]
          : []),
      ),
      ...(['input', 'model', 'tool'] as const).map((lane) =>
        createElement(
          'div',
          { className: 'trace-gantt-row', key: lane },
          createElement(
            'span',
            { className: 'trace-gantt-label' },
            lane === 'input' ? '输入' : lane === 'model' ? '模型' : '工具',
          ),
          createElement(
            'div',
            {
              className: 'trace-gantt-track',
              ref: lane === 'input' ? timelineTrackRef : undefined,
              tabIndex: lane === 'input' ? 0 : -1,
              role: 'presentation',
              onPointerDown: timelinePointerDown,
              onPointerMove: timelinePointerMove,
              onPointerUp: timelinePointerUp,
              onPointerCancel: timelinePointerCancel,
              onContextMenu: (event: Event) => event.preventDefault(),
              onDoubleClick: () => setTimelineRange(null),
              onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                if (event.key === 'Escape' && timelineRange) {
                  event.preventDefault()
                  setTimelineRange(null)
                }
              },
              'aria-label': `${lane === 'input' ? '输入' : lane === 'model' ? '模型' : '工具'}时间轴：拖动筛选，滚轮缩放，右键拖动平移`,
            },
            ...(activeTimelineRange
              ? [
                  createElement('span', {
                    key: 'selection',
                    className: 'trace-gantt-selection',
                    'aria-hidden': true,
                    style: {
                      left: `${projectedPosition(activeTimelineRange.start)}%`,
                      width: `${((activeTimelineRange.end - activeTimelineRange.start) / viewportWidth) * 100}%`,
                    },
                  }),
                ]
              : []),
            ...timelineUnits
              .filter((unit) => unit.lane === lane)
              .map((unit) => {
                const bar = unit.members[0]
                if (!bar) return null
                const cluster = unit.kind === 'cluster'
                const marker = cluster ? unit.domainEnd <= unit.domainStart : bar.marker
                const targets = unit.members.filter((member) => member.targetId)
                const title = cluster ? `${unit.count} 条记录 · 点击定位最近记录` : bar.title
                return createElement(targets.length ? 'button' : 'span', {
                  className: `trace-gantt-bar lane-${lane}${!cluster && bar.tone ? ` tone-${bar.tone}` : ''}${!cluster && bar.truncated ? ' truncated' : ''}${marker ? ' marker' : ''}${cluster ? ' cluster' : ''}`,
                  key: unit.key,
                  ...(targets.length
                    ? {
                        type: 'button',
                        'aria-label': title,
                        'aria-pressed': unit.members.some((member) => member.targetId === selected)
                          ? 'true'
                          : 'false',
                        ...(cluster ? { 'data-count': unit.count } : { 'data-target-id': bar.targetId }),
                        'data-in-range': timelineRange
                          ? unit.members.some((member) => barIntersectsRange(member, timelineRange))
                          : undefined,
                        onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
                          const track = event.currentTarget.parentElement
                          const rect = track?.getBoundingClientRect()
                          const fraction = rect
                            ? clampPercent(((event.clientX - rect.left) / Math.max(1, rect.width)) * 100) /
                              100
                            : 0.5
                          const point = viewportStart + fraction * viewportWidth
                          const chosen = cluster
                            ? pickTraceTimelineDensityMember({ ...unit, members: targets }, point)
                            : bar
                          if (chosen.targetId) selectRow(chosen.targetId)
                        },
                      }
                    : { 'aria-hidden': true }),
                  style: {
                    left: marker
                      ? `min(${projectedPosition(unit.domainStart)}%, calc(100% - 6px))`
                      : `${projectedPosition(unit.domainStart)}%`,
                    width: cluster
                      ? `${((unit.domainEnd - unit.domainStart) / viewportWidth) * 100}%`
                      : `${(bar.width * fullTimelineWidth) / viewportWidth}%`,
                  },
                  title,
                })
              }),
          ),
        ),
      ),
    ),
    createElement(
      'div',
      { className: 'trace-body', hidden: rows.length === 0 },
      createElement(
        'div',
        {
          className: 'trace-list',
          role: 'list',
          ref: listRef,
          onScroll: (event: { currentTarget: HTMLDivElement }) => {
            if (!virtualized) return
            const next = getTraceVirtualWindow(
              listLayout,
              event.currentTarget.scrollTop,
              listViewportHeight,
              256,
            )
            if (next.start !== listWindow.start || next.end !== listWindow.end)
              setListScrollTop(event.currentTarget.scrollTop)
          },
        },
        ...(virtualized && listWindow.topPadding
          ? [
              createElement('div', {
                key: 'top-spacer',
                className: 'trace-list-spacer',
                'aria-hidden': true,
                style: { height: `${listWindow.topPadding}px` },
              }),
            ]
          : []),
        ...listItems.slice(listWindow.start, listWindow.end).map((item) => {
          if (item.kind === 'header' && 'loadEarlier' in item)
            return createElement(
              'button',
              {
                key: item.key,
                className: 'trace-load-earlier',
                type: 'button',
                onClick: () => {
                  const list = listRef.current
                  earlierPosition.current = {
                    sessionId: snapshot.meta?.sessionId,
                    firstNodeId: snapshot.nodes[0]?.id,
                    anchor: list ? captureTraceVirtualAnchor(listLayout, list.scrollTop) : undefined,
                  }
                  item.loadEarlier()
                },
              },
              '加载更早的记录',
            )
          if (item.kind === 'header')
            return createElement(
              'div',
              { className: 'trace-turn-header', role: 'listitem', key: item.key },
              createElement(
                'button',
                {
                  className: 'trace-turn-toggle',
                  type: 'button',
                  disabled: focusActive,
                  'aria-expanded': !item.collapsed,
                  onClick: () => toggleTurn(item.turn),
                },
                `${item.collapsed ? '▸' : '▾'} 第 ${item.turn} 轮 · ${item.count} 条记录${item.collapsed ? '（已折叠）' : ''}`,
              ),
            )
          const row = item.row
          const request = row.callUsage ? requestMetrics.get(row.callUsage.seq) : undefined
          const requestPrefix =
            request?.requestNumber.state === 'known' ? `请求 #${request.requestNumber.value} · ` : ''
          const children = toolHierarchy.childrenById.get(row.id) ?? []
          const toolDepth = row.badge === '工具' ? Math.min(8, toolHierarchy.depthById.get(row.id) ?? 0) : 0
          const nested = row.badge === '工具' && (children.length > 0 || toolDepth > 0)
          const rowButton = createElement(
            'button',
            {
              className: 'trace-row',
              type: 'button',
              role: nested ? undefined : 'listitem',
              'data-trace-row-id': row.id,
              'aria-current': row.id === selected ? 'true' : undefined,
              onClick: () => selectRow(row.id),
              ...(nested ? { style: { paddingLeft: `${24 + toolDepth * 16}px` } } : {}),
            },
            createElement('span', { className: 'trace-step-mark' }, item.showStep ? row.step : undefined),
            createElement('span', { className: `trace-badge kind-${row.badge}` }, row.badge),
            createElement(
              'span',
              { className: 'trace-row-preview' },
              `${requestPrefix}${clip(row.preview, 160) || '（无内容）'}${row.status === '已完成' ? '' : ` · ${row.status}`}${row.errorCode ? ` · ${row.errorCode}` : ''}`,
            ),
          )
          if (!nested) return createElement('div', { key: item.key, className: 'trace-row-entry' }, rowButton)
          return createElement(
            'div',
            { key: item.key, className: 'trace-tool-entry', role: 'listitem' },
            ...(children.length
              ? [
                  createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'trace-tool-toggle',
                      style: { left: `${4 + toolDepth * 16}px` },
                      'aria-label': collapsedTools.has(row.id)
                        ? `展开 ${row.source} 的子调用`
                        : `折叠 ${row.source} 的子调用`,
                      'aria-expanded': focusActive || !collapsedTools.has(row.id),
                      disabled: focusActive,
                      onClick: () => toggleTool(row.id),
                    },
                    collapsedTools.has(row.id) && !focusActive ? '▸' : '▾',
                  ),
                ]
              : []),
            rowButton,
          )
        }),
        ...(virtualized && listWindow.bottomPadding
          ? [
              createElement('div', {
                key: 'bottom-spacer',
                className: 'trace-list-spacer',
                'aria-hidden': true,
                style: { height: `${listWindow.bottomPadding}px` },
              }),
            ]
          : []),
        ...(rows.length > 0 && visibleRows.length === 0
          ? [
              createElement(
                'p',
                { key: 'no-results', className: 'trace-no-results', role: 'status' },
                '当前范围没有匹配记录',
              ),
            ]
          : []),
      ),
      ...omitted.map((note) =>
        createElement(
          'p',
          { key: `omitted:${note.key}`, className: 'trace-truncated', role: 'note' },
          `第 ${note.turn} 轮 · ${note.label}`,
        ),
      ),
      inspector,
    ),
    ...(lightbox
      ? [
          createElement(
            'div',
            {
              className: 'trace-lightbox',
              role: 'dialog',
              'aria-modal': true,
              'aria-label': lightbox.alt,
              onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                if (event.key === 'Escape') setLightbox(null)
                if (event.key === 'Tab') {
                  event.preventDefault()
                  root.querySelector<HTMLButtonElement>('.trace-lightbox-close')?.focus()
                }
              },
            },
            createElement(
              'button',
              {
                type: 'button',
                className: 'trace-lightbox-close',
                'aria-label': '关闭图片预览',
                onClick: () => setLightbox(null),
              },
              '×',
            ),
            createElement('img', { src: lightbox.src, alt: lightbox.alt }),
          ),
        ]
      : []),
    createElement(
      'p',
      { className: 'trace-empty', hidden: rows.length > 0 },
      '发送一条任务后，这里会按步骤显示耗时。',
    ),
  )
})
