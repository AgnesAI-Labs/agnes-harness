import type { UINode, UISpan, UITurn } from '@agnes/protocol'
import {
  createElement,
  type ForwardedRef,
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'

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
export type TraceMeta = { hasEarlier: boolean; loadEarlier?: () => void }

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
}

export type TraceRow = {
  id: string
  seq: number
  turn?: number | undefined
  badge: string
  preview: string
  raw: string
  source: string
  status: string
  durationMs?: number | undefined
  ttftMs?: number | undefined
  model?: string | undefined
}

type GanttBar = {
  key: string
  truncated?: string
  lane: 'input' | 'model' | 'tool'
  tone?: 'user' | 'context' | 'system'
  left: number
  width: number
  title: string
}

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`

export const durationLabel = (duration?: number): string => {
  if (duration === undefined) return '进行中'
  if (duration < 1000) return `${duration} 毫秒`
  if (duration < 60_000) return `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)} 秒`
  return `${Math.floor(duration / 60_000)} 分 ${Math.round((duration % 60_000) / 1000)} 秒`
}

const walkSpans = (span: UISpan, visit: (item: UISpan) => void): void => {
  visit(span)
  for (const child of span.children) walkSpans(child, visit)
}

const nodePreview = (node: UINode): string => {
  if (node.kind === 'user')
    return node.content
      .filter(
        (block): block is Extract<(typeof node.content)[number], { type: 'text' }> => block.type === 'text',
      )
      .map((block) => block.text)
      .join('\n')
  if (node.kind === 'assistant') return node.text || node.thinking || ''
  if (node.kind === 'context') return node.text
  if (node.kind === 'tool') {
    const args = node.argsPreview ? ` ${node.argsPreview}` : ''
    const result = node.resultPreview ? ` → ${node.resultPreview}` : ''
    return `${node.name}${args}${result}`
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

type Placed = { span: UISpan; order: number }

/**
 * One pass over a snapshot. A node belongs to the first turn that lists it and to the span that
 * comes first in turn and depth-first order among those naming it by id or, for a tool node, by
 * tool use; nodes no turn lists fall back to the turn whose sequence range holds them.
 */
function indexTrace(turns: readonly UITurn[]) {
  const turnByNode = new Map<string, UITurn>()
  const spanByNode = new Map<string, Placed>()
  const spanByToolUse = new Map<string | undefined, Placed>()
  let order = 0
  for (const turn of turns) {
    for (const id of turn.nodeIds) if (!turnByNode.has(id)) turnByNode.set(id, turn)
    if (!turn.trace) continue
    walkSpans(turn.trace, (span) => {
      const placed = { span, order: order++ }
      for (const id of span.nodeIds ?? []) if (!spanByNode.has(id)) spanByNode.set(id, placed)
      if (!spanByToolUse.has(span.toolUseId)) spanByToolUse.set(span.toolUseId, placed)
    })
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
    spanFor(node: UINode): UISpan | undefined {
      const byId = spanByNode.get(node.id)
      const byTool = node.kind === 'tool' ? spanByToolUse.get(node.toolUseId) : undefined
      if (!byTool) return byId?.span
      return !byId || byTool.order < byId.order ? byTool.span : byId.span
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
    const span = index.spanFor(node)
    const cached = rowCache.get(node)
    if (cached && cached.turn === turn && cached.span === span) {
      rows.push(cached.row)
      continue
    }
    const preview = nodePreview(node).replace(/\s+/g, ' ').trim()
    const row: TraceRow = {
      id: node.id,
      seq: node.seq,
      turn: turn?.turn,
      badge: BADGE[node.kind] ?? node.kind,
      preview,
      raw: nodeRaw(node),
      source: nodeSource(node),
      status:
        node.kind === 'tool'
          ? (STATUS_LABEL[node.status] ?? node.status)
          : (STATUS_LABEL[span?.status ?? ''] ?? '已完成'),
      durationMs: span?.durationMs,
      ttftMs: span?.ttftMs,
      model: span?.model,
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
  lane: GanttBar['lane']
  tone?: GanttBar['tone']
  start: number
  end: number
  title: string
}

const IDLE_GAP_MS = 120

function compress(events: GanttEvent[]): GanttBar[] {
  if (events.length === 0) return []
  const ordered = [...events].sort((a, b) => a.start - b.start || a.end - b.end)
  let wall = ordered[0]?.start ?? 0
  let cursor = 0
  const placed: Array<GanttEvent & { compactStart: number; compactEnd: number }> = []
  for (const event of ordered) {
    if (event.start > wall + IDLE_GAP_MS) {
      cursor += 48
      wall = event.start
    } else if (event.start > wall) {
      cursor += event.start - wall
      wall = event.start
    }
    const duration = Math.max(event.end - event.start, 80)
    const compactStart = cursor
    const compactEnd = cursor + duration
    placed.push({ ...event, compactStart, compactEnd })
    if (event.end > wall) {
      cursor += event.end - wall
      wall = event.end
    } else cursor = compactEnd
  }
  const total = Math.max(placed[placed.length - 1]?.compactEnd ?? 1, 1)
  return placed.map((event) => ({
    key: event.key,
    ...(event.truncated ? { truncated: event.truncated } : {}),
    lane: event.lane,
    ...(event.tone ? { tone: event.tone } : {}),
    left: (event.compactStart / total) * 100,
    width: Math.max(1.8, ((event.compactEnd - event.compactStart) / total) * 100),
    title: event.title,
  }))
}

function buildGantt(turns: readonly UITurn[], nodes: readonly UINode[] = []): GanttBar[] {
  const events: GanttEvent[] = []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
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
    let firstModel = origin + (turn.durationMs ?? 1)
    walkSpans(turn.trace, (span) => {
      if (span.kind !== 'generation') return
      const at = Date.parse(span.startedAt)
      if (Number.isFinite(at) && at < firstModel) firstModel = at
    })
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
    const inputEnd = Math.max(firstModel, origin + 80)
    if (turnInputs.length === 0) {
      events.push({
        key: `input:${turn.id}`,
        lane: 'input',
        start: origin,
        end: inputEnd,
        title: `第 ${turn.turn} 轮输入`,
      })
    } else {
      const slice = (inputEnd - origin) / turnInputs.length
      turnInputs.forEach((node, index) => {
        const start = origin + slice * index
        events.push({
          key: `input:${turn.id}:${node.id}`,
          lane: 'input',
          tone: node.kind === 'user' ? 'user' : 'context',
          start,
          end: start + slice,
          title: node.kind === 'user' ? '用户' : '上下文',
        })
      })
    }
    walkSpans(turn.trace, (span) => {
      const at = Date.parse(span.startedAt)
      if (!Number.isFinite(at)) return
      const duration = span.durationMs ?? 80
      if (span.kind === 'generation')
        events.push({
          key: span.id,
          lane: 'model',
          start: at,
          end: at + duration,
          title: span.model ?? span.name,
        })
      if (span.kind === 'tool')
        events.push({ key: span.id, lane: 'tool', start: at, end: at + duration, title: span.name })
      if (isTruncation(span)) {
        const label = truncationLabel(span)
        events.push({ key: span.id, truncated: label, lane: 'tool', start: at, end: at + 80, title: label })
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
  return compress(events)
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
  ['raw', '原始内容'],
  ['source', '来源'],
] as const

type InspectorPane = (typeof INSPECTOR_PANES)[number][0]

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
  const rows = useMemo(() => traceRowBuilder.build(snapshot.nodes, snapshot.turns), [snapshot])
  const selectedRow = selected ? rows.find((row) => row.id === selected) : undefined

  const applyOpen = (next: boolean, persist: boolean): void => {
    open.current = next
    const pending = latest.current
    if (next && pending) {
      latest.current = undefined
      flushSync(() => setSnapshot(pending))
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
        flushSync(() => {
          setSnapshot({ nodes, turns, meta })
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

  const visibleRows = rows.filter((row) => {
    if (!query) return true
    const hay = `${row.badge} ${row.preview} ${row.raw} ${row.source}`.toLowerCase()
    return hay.includes(query)
  })
  const bars = useMemo(() => buildGantt(snapshot.turns, snapshot.nodes), [snapshot])
  const omitted = useMemo(() => truncations(snapshot.turns), [snapshot])
  const meta = snapshot.meta
  const selectRow = (id: string): void => {
    flushSync(() => {
      setSelected(id)
      setPane('overview')
    })
  }
  const closeInspector = (): void => flushSync(() => setSelected(undefined))
  const selectPane = (next: InspectorPane): void => flushSync(() => setPane(next))
  const updateQuery = (event: { currentTarget: HTMLInputElement }): void =>
    flushSync(() => setQuery(event.currentTarget.value.trim().toLowerCase()))
  const paneField = (label: string, value: string) =>
    createElement(
      'div',
      { className: 'trace-field', key: label },
      createElement('div', { className: 'trace-field-label' }, label),
      createElement('div', { className: 'trace-field-value' }, value),
    )
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
            selectedRow.turn ? `第 ${selectedRow.turn} 轮 · 消息` : '消息',
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
          ...INSPECTOR_PANES.map(([id, label]) =>
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
          paneField('时长', durationLabel(selectedRow.durationMs)),
          ...(selectedRow.ttftMs === undefined ? [] : [paneField('首字', durationLabel(selectedRow.ttftMs))]),
          ...(selectedRow.model === undefined ? [] : [paneField('模型', selectedRow.model)]),
        ),
        createElement(
          'div',
          { className: 'trace-inspector-pane', hidden: pane !== 'preview' },
          createElement('pre', { className: 'trace-pre' }, selectedRow.preview || '（无预览）'),
        ),
        createElement(
          'div',
          { className: 'trace-inspector-pane', hidden: pane !== 'raw' },
          createElement('pre', { className: 'trace-pre' }, selectedRow.raw || '（无原始内容）'),
        ),
        createElement(
          'div',
          { className: 'trace-inspector-pane', hidden: pane !== 'source' },
          paneField('来源', selectedRow.source),
        ),
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
      { className: 'trace-gantt', 'aria-hidden': true, hidden: rows.length === 0 },
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
            { className: 'trace-gantt-track' },
            ...bars
              .filter((bar) => bar.lane === lane)
              .map((bar) =>
                createElement('span', {
                  className: `trace-gantt-bar lane-${lane}${bar.tone ? ` tone-${bar.tone}` : ''}${bar.truncated ? ' truncated' : ''}`,
                  key: bar.key,
                  style: { left: `${bar.left}%`, width: `${bar.width}%` },
                  title: bar.title,
                }),
              ),
          ),
        ),
      ),
    ),
    createElement(
      'div',
      { className: 'trace-body', hidden: rows.length === 0 },
      createElement(
        'div',
        { className: 'trace-list', role: 'list' },
        ...(meta?.hasEarlier && meta.loadEarlier
          ? [
              createElement(
                'button',
                {
                  key: 'load-earlier',
                  className: 'trace-load-earlier',
                  type: 'button',
                  onClick: meta.loadEarlier,
                },
                '加载更早的记录',
              ),
            ]
          : []),
        ...visibleRows.map((row, index) =>
          createElement(
            'button',
            {
              key: row.id,
              className: 'trace-row',
              type: 'button',
              role: 'listitem',
              'aria-current': row.id === selected ? 'true' : undefined,
              onClick: () => selectRow(row.id),
            },
            createElement(
              'span',
              { className: 'trace-turn-mark' },
              row.turn !== undefined && (index === 0 || visibleRows[index - 1]?.turn !== row.turn)
                ? `第 ${row.turn} 轮`
                : undefined,
            ),
            createElement('span', { className: `trace-badge kind-${row.badge}` }, row.badge),
            createElement('span', { className: 'trace-row-preview' }, clip(row.preview, 160) || '（无内容）'),
          ),
        ),
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
    createElement(
      'p',
      { className: 'trace-empty', hidden: rows.length > 0 },
      '发送一条任务后，这里会按步骤显示耗时。',
    ),
  )
})
