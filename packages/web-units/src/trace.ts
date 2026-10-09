import type { SessionControlFact } from '@agnes/protocol/gen/agnes-v1'
import { SettingsInput, SettingsSelect } from '@agnes/web-ui'
import {
  BADGE_KEY,
  buildGantt,
  buildTraceRows,
  clip,
  durationLabel,
  type GanttBar,
  metricLabel,
  metricTokensLabel,
  type TimelineMode,
  type TimelineRange,
  type TraceRow,
  tokenLabel,
  traceRowBuilder,
  traceStats,
  truncations,
} from './trace-model.js'

export { buildTraceRows, durationLabel, type TraceRow, traceRowBuilder } from './trace-model.js'

import type { ToolCall, ToolResult, UINode, UITurn } from '@agnes/protocol'
import {
  createElement,
  type ForwardedRef,
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { flushSync } from 'react-dom'
import { buildTraceToolHierarchy, isTraceRowHiddenByTool, traceToolAncestors } from './trace-hierarchy.js'
import { type TraceMessageKey, traceLocale, traceText } from './trace-locale.js'
import { RequestTraceView } from './trace-request.js'
import { buildTraceRequestMetrics } from './trace-request-metrics.js'
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

/** What the host knows beyond the loaded snapshot: whether older records exist, and how to load them. */
export type TraceMeta = {
  controlFacts?: readonly SessionControlFact[]
  hasEarlier: boolean
  loadEarlier?: () => void
  sessionId?: string
  loop?: { id: string; version: string }
}

export type TraceHandle = {
  render(nodes: readonly UINode[], turns?: readonly UITurn[], meta?: TraceMeta): void
  setOpen(open: boolean): void
  isOpen(): boolean
  selectTool?(sessionId: string, callSeq: number, resultSeq?: number): boolean
}

export type TracePanel = TraceHandle

export type TracePanelOptions = {
  root: HTMLElement
  toggle: HTMLButtonElement
  chatToggle?: HTMLButtonElement
  conversation?: HTMLElement
  store?: Pick<Storage, 'getItem' | 'setItem'>
  clearModelRequest?: (
    params: import('@agnes/protocol').ModelRequestClearParams,
  ) => Promise<import('@agnes/protocol').ModelRequestClearResult>
  openFactChain?: (input: import('@agnes/protocol').FactChainParams) => boolean
  readModelRequest?: (
    params: import('@agnes/protocol').ModelRequestParams,
    signal?: AbortSignal,
  ) => Promise<import('@agnes/protocol').ModelRequestResult>
  readToolDetail?: (
    sessionId: string,
    callSeq: number,
    resultSeq?: number,
    signal?: AbortSignal,
  ) => Promise<{ call: ToolCall; result?: ToolResult }>
}

type TraceListItem =
  | { key: 'load-earlier'; kind: 'header'; loadEarlier: () => void }
  | { key: string; kind: 'header'; turn: number; count: number; collapsed: boolean }
  | { key: string; kind: 'row'; row: TraceRow; showStep: boolean }

const TRACE_ROW_HEIGHT = 32
const TRACE_HEADER_HEIGHT = 33
const TRACE_VIRTUAL_THRESHOLD = 100

export interface TraceProps {
  root: HTMLElement
  options: Omit<TracePanelOptions, 'root'>
}

const INSPECTOR_PANE_IDS = ['overview', 'preview', 'raw', 'source'] as const
const PANE_KEY = {
  overview: 'trace.pane.overview',
  preview: 'trace.pane.preview',
  raw: 'trace.pane.raw',
  source: 'trace.pane.source',
  input: 'trace.pane.input',
  output: 'trace.pane.output',
  timing: 'trace.pane.timing',
} as const satisfies Record<string, TraceMessageKey>

type InspectorPane = keyof typeof PANE_KEY

const laneName = (lane: 'input' | 'model' | 'tool'): string =>
  traceText(lane === 'input' ? 'trace.lane.input' : lane === 'model' ? 'trace.lane.model' : 'trace.lane.tool')
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
  const currentSnapshot = useRef(snapshot)
  currentSnapshot.current = snapshot
  const selectRowRef = useRef<((id: string) => void) | undefined>(undefined)
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 900px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)')
    const update = () => setCompact(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState('all')
  const [selected, setSelected] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!compact || !selected) return
    const previous = document.activeElement
    root.querySelector<HTMLButtonElement>('.trace-inspector-close')?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [compact, selected, root])
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
  const locale = useSyncExternalStore((listener) => {
    window.addEventListener('agnes:locale-changed', listener)
    return () => window.removeEventListener('agnes:locale-changed', listener)
  }, traceLocale)
  // buildTraceRows reads the document language itself. locale is only the subscription snapshot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: locale changes the formatted row text
  const rows = useMemo(
    () => traceRowBuilder.build(snapshot.nodes, snapshot.turns),
    [snapshot.nodes, snapshot.turns, locale],
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
    if (options.toggle.getAttribute('role') === 'tab') options.toggle.removeAttribute('aria-pressed')
    else options.toggle.setAttribute('aria-pressed', next ? 'true' : 'false')
    options.toggle.setAttribute('aria-selected', next ? 'true' : 'false')
    if (options.chatToggle) {
      options.chatToggle.setAttribute('aria-selected', next ? 'false' : 'true')
      if (options.chatToggle.getAttribute('role') === 'tab')
        options.chatToggle.removeAttribute('aria-pressed')
      else options.chatToggle.setAttribute('aria-pressed', next ? 'false' : 'true')
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
      selectTool(sessionId, callSeq, resultSeq) {
        const value = latest.current ?? currentSnapshot.current
        if (value.meta?.sessionId !== sessionId) return false
        const node = value.nodes.find(
          (node) =>
            node.kind === 'tool' &&
            node.seq === callSeq &&
            (resultSeq === undefined || node.resultSeq === resultSeq),
        )
        applyOpenRef.current(true, true)
        if (!node) return false
        flushSync(() => {
          setQuery('')
          setTimelineRange(null)
          setTimelineViewport(null)
          setCollapsedTurns(new Set())
          setCollapsedTools(new Set())
          setLightbox(null)
        })
        selectRowRef.current?.(node.id)
        return true
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
        if (kindFilter !== 'all' && row.kind !== kindFilter) return false
        if (rangeIds && !rangeIds.has(row.id)) return false
        if (!query && !timelineRange && isTraceRowHiddenByTool(toolHierarchy, row.id, collapsedTools))
          return false
        if (!query) return true
        const hay =
          `${row.badge} ${row.step ?? ''} ${row.preview} ${row.raw} ${row.source} ${row.errorCode ?? ''}`.toLowerCase()
        return hay.includes(query)
      }),
    [rows, rangeIds, query, timelineRange, toolHierarchy, collapsedTools, kindFilter],
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
  const focusActive = Boolean(query || timelineRange || kindFilter !== 'all')
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
  // truncation labels are formatted from the document language. locale is the subscription snapshot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: locale changes the omitted-step text
  const omitted = useMemo(() => truncations(snapshot.turns), [snapshot.turns, locale])
  const meta = snapshot.meta
  const selectRow = useCallback(
    (id: string): void => {
      const bar = timelineViewport ? bars.find((item) => item.targetId === id) : undefined
      const revealBar = bar && (bar.domainStart > viewportEnd || bar.domainEnd < viewportStart)
      flushSync(() => {
        if (!visibleRows.some((row) => row.id === id)) {
          setQuery('')
          setKindFilter('all')
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
    },
    [
      timelineViewport,
      bars,
      viewportEnd,
      viewportStart,
      visibleRows,
      rows,
      collapsedTurns,
      toolHierarchy,
      collapsedTools,
      timelineModel.start,
      timelineModel.end,
      viewportWidth,
      root,
      listViewportHeight,
    ],
  )
  useEffect(() => {
    const conversation = options.conversation
    if (!conversation) return
    const jump = (event: Event) => {
      const turnId = (event as CustomEvent<{ turnId?: string }>).detail?.turnId
      const active = latest.current ?? snapshot
      const turn = active.turns.find((item) => item.id === turnId)
      if (!turn) return
      const target = buildTraceRows(active.nodes, active.turns)
        .filter((row) => row.turn === turn.turn)
        .findLast((row) => row.kind === 'assistant')
      if (!target) return
      options.toggle.click()
      selectRow(target.id)
    }
    conversation.addEventListener('agnes:trace-turn', jump)
    return () => conversation.removeEventListener('agnes:trace-turn', jump)
  }, [options.conversation, options.toggle, snapshot, selectRow])
  selectRowRef.current = selectRow
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
  const inspectorPaneIds: readonly InspectorPane[] = selectedToolKey
    ? [...INSPECTOR_PANE_IDS, 'input', 'output', 'timing']
    : [...INSPECTOR_PANE_IDS]
  const detailValue = activeToolDetail?.status === 'ready' ? activeToolDetail.value : undefined
  const detailNotice = () =>
    activeToolDetail?.status === 'error'
      ? createElement(
          'p',
          { className: 'trace-detail-status', role: 'alert' },
          traceText('trace.detail.readFailed', { message: activeToolDetail.message }),
        )
      : createElement(
          'p',
          { className: 'trace-detail-status', role: 'status' },
          activeToolDetail?.status === 'loading'
            ? traceText('trace.detail.loading')
            : traceText('trace.detail.empty'),
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
                  'aria-label': traceText('trace.image.viewResult', { n: index + 1 }),
                  onClick: () =>
                    setLightbox({ src, alt: traceText('trace.image.resultAlt', { n: index + 1 }) }),
                },
                createElement('img', { src, alt: traceText('trace.image.resultAlt', { n: index + 1 }) }),
              )
            : traceText('trace.image.mime', { mime: block.mimeType }),
        )
      }
      return createElement(
        'p',
        { className: 'trace-detail-resource', key: `resource:${index}` },
        traceText('trace.resource.link', {
          name: `${block.name ?? (block.type === 'resource_link' ? block.uri : '')}${block.mimeType ? ` · ${block.mimeType}` : ''}`,
        }),
      )
    })
  const stepLabel = (step: string | undefined) => {
    const match = /^Step (\d+)$/i.exec(step ?? '')
    return match ? traceText('trace.stepNumber', { n: match[1]! }) : step
  }
  const inspector = selectedRow
    ? createElement(
        'aside',
        {
          className: 'trace-inspector',
          onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
            if (compact && event.key === 'Escape' && !event.defaultPrevented) {
              event.preventDefault()
              closeInspector()
            }
          },
        },
        createElement(
          'header',
          { className: 'trace-inspector-head' },
          createElement('span', { className: `trace-badge kind-${selectedRow.kind}` }, selectedRow.badge),
          createElement(
            'h2',
            { className: 'trace-inspector-title' },
            [
              selectedRow.turn ? traceText('trace.inspector.turn', { turn: selectedRow.turn }) : undefined,
              stepLabel(selectedRow.step),
              traceText('trace.inspector.message'),
            ]
              .filter(Boolean)
              .join(' · '),
          ),
          options.chatToggle && selectedRow.turn !== undefined
            ? createElement(
                'button',
                {
                  type: 'button',
                  className: 'trace-detail-copy',
                  'data-testid': 'trace-view-chat',
                  onClick: () => {
                    const turn = snapshot.turns.find((item) => item.turn === selectedRow.turn)
                    options.chatToggle?.click()
                    const target = [
                      ...(options.conversation?.querySelectorAll<HTMLElement>('[data-turn-id]') ?? []),
                    ].find((item) => item.dataset.turnId === turn?.id)
                    target?.scrollIntoView?.({ block: 'center' })
                  },
                },
                traceText('trace.jump.chat'),
              )
            : null,
          createElement(
            'button',
            {
              className: 'trace-inspector-close',
              type: 'button',
              'aria-label': traceText('trace.closeDetail'),
              onClick: closeInspector,
            },
            '×',
          ),
        ),
        selectedRow.review
          ? createElement(
              'section',
              { 'data-testid': 'trace-auto-review' },
              createElement('p', null, traceText('trace.review.model', { model: selectedRow.review.model })),
              createElement(
                'p',
                null,
                traceText('trace.review.decision', {
                  decision: selectedRow.review.decision,
                  risk: selectedRow.review.risk,
                }),
              ),
              createElement('p', null, selectedRow.review.reason),
              createElement('pre', null, JSON.stringify(selectedRow.review, null, 2)),
            )
          : null,
        selectedRow.requestTraceId && snapshot.meta?.sessionId && options.openFactChain
          ? createElement(
              'button',
              {
                type: 'button',
                className: 'trace-detail-copy',
                'data-testid': 'trace-fact-chain',
                onClick: () =>
                  options.openFactChain?.({
                    sessionId: snapshot.meta!.sessionId!,
                    laneId: 'main',
                    anchor: { kind: 'request', callId: selectedRow.requestTraceId! },
                  }),
              },
              traceLocale() === 'zh-CN' ? '查看执行依据' : 'View execution evidence',
            )
          : null,
        selectedRow.requestTraceId && snapshot.meta?.sessionId && options.readModelRequest
          ? createElement(RequestTraceView, {
              key: `${snapshot.meta.sessionId}:${selectedRow.requestTraceId}`,
              sessionId: snapshot.meta.sessionId,
              callId: selectedRow.requestTraceId,
              read: options.readModelRequest,
              ...(options.clearModelRequest ? { clear: options.clearModelRequest } : {}),
              locale: traceLocale(),
            })
          : null,
        createElement(
          'div',
          { className: 'trace-inspector-tabs' },
          ...inspectorPaneIds.map((id) =>
            createElement(
              'button',
              {
                key: id,
                className: 'trace-tab',
                type: 'button',
                'data-pane': id,
                'aria-pressed': pane === id ? 'true' : 'false',
                onClick: () => selectPane(id),
              },
              traceText(PANE_KEY[id]),
            ),
          ),
        ),
        createElement(
          'div',
          { className: 'trace-inspector-pane', hidden: pane !== 'overview' },
          paneField(traceText('trace.field.source'), selectedRow.source),
          paneField(traceText('trace.field.status'), selectedRow.status),
          ...(selectedRow.errorCode
            ? [paneField(traceText('trace.field.errorCode'), selectedRow.errorCode)]
            : []),
          ...(selectedRow.attachments?.length
            ? [
                paneField(
                  traceText('trace.field.attachments'),
                  selectedRow.attachments.join(traceText('trace.join.list')),
                ),
              ]
            : []),
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
                      'aria-label': traceText('trace.image.viewInput', { n: index + 1 }),
                      onClick: () =>
                        setLightbox({ src, alt: traceText('trace.image.inputAlt', { n: index + 1 }) }),
                    },
                    createElement('img', { src, alt: traceText('trace.image.inputAlt', { n: index + 1 }) }),
                  ),
                ]
              })
            : []),
          ...(selectedRow.step
            ? [paneField(traceText('trace.field.step'), stepLabel(selectedRow.step) ?? '')]
            : []),
          ...(selectedRow.durationMs !== undefined || selectedRow.statusCode === 'running'
            ? [paneField(traceText('trace.field.duration'), durationLabel(selectedRow.durationMs))]
            : []),
          ...(selectedRow.ttftMs === undefined
            ? []
            : [paneField(traceText('trace.field.ttft'), durationLabel(selectedRow.ttftMs))]),
          ...(selectedRow.model === undefined
            ? []
            : [paneField(traceText('trace.field.model'), selectedRow.model)]),
          ...(selectedRow.usage === undefined
            ? []
            : [
                paneField(
                  traceText('trace.field.turnUsage'),
                  tokenLabel(selectedRow.usage.totals, selectedRow.usage.reasoningComplete),
                ),
              ]),
          ...(selectedRow.callUsage?.tokens
            ? [
                paneField(
                  traceText('trace.field.callUsage'),
                  tokenLabel(
                    selectedRow.callUsage.tokens,
                    selectedRow.callUsage.tokens.reasoning !== undefined,
                  ),
                ),
              ]
            : []),
          ...(selectedRequest
            ? [
                paneField(traceText('trace.field.requestOrder'), metricLabel(selectedRequest.requestNumber)),
                paneField(traceText('trace.field.ledgerOrder'), metricLabel(selectedRequest.ledgerNumber)),
                paneField(
                  traceText('trace.field.cumulativeUsage'),
                  metricTokensLabel(selectedRequest.cumulativeTokens),
                ),
                paneField(
                  traceText('trace.field.callDuration'),
                  selectedRequest.durationMs.state === 'known'
                    ? durationLabel(selectedRequest.durationMs.value)
                    : metricLabel(selectedRequest.durationMs),
                ),
                paneField(
                  traceText('trace.field.cumulativeDuration'),
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
          createElement(
            'pre',
            { className: 'trace-pre' },
            selectedRow.preview || traceText('trace.emptyPreview'),
          ),
        ),
        createElement(
          'div',
          { className: 'trace-inspector-pane', hidden: pane !== 'raw' },
          ...(selectedRow.rawNote
            ? [createElement('p', { className: 'trace-raw-note' }, selectedRow.rawNote)]
            : []),
          createElement('pre', { className: 'trace-pre' }, selectedRow.raw || traceText('trace.emptyRaw')),
        ),
        createElement(
          'div',
          { className: 'trace-inspector-pane', hidden: pane !== 'source' },
          paneField(traceText('trace.field.source'), selectedRow.source),
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
                        copyDetail(
                          traceText('trace.detail.copyInput'),
                          JSON.stringify(detailValue.call.args),
                        ),
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
                      ? [
                          createElement(
                            'p',
                            { className: 'trace-detail-status' },
                            traceText('trace.detail.resultMissing'),
                          ),
                        ]
                      : [
                          paneField(
                            traceText('trace.field.result'),
                            detailValue.result.isError
                              ? traceText('trace.result.failed')
                              : traceText('trace.result.completed'),
                          ),
                          ...(detailValue.result.code
                            ? [paneField(traceText('trace.field.errorCode'), detailValue.result.code)]
                            : []),
                          copyDetail(
                            traceText('trace.detail.copyResult'),
                            JSON.stringify(detailValue.result),
                          ),
                          ...toolResultBlocks(detailValue.result),
                          ...(detailValue.result.structured === undefined
                            ? []
                            : [
                                createElement(
                                  'h3',
                                  { className: 'trace-detail-heading' },
                                  traceText('trace.detail.structured'),
                                ),
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
                ...(selectedRow.startedAt
                  ? [paneField(traceText('trace.field.startedAt'), selectedRow.startedAt)]
                  : []),
                paneField(
                  traceText('trace.field.duration'),
                  selectedRow.durationMs === undefined && selectedRow.statusCode !== 'running'
                    ? traceText('trace.duration.unknown')
                    : durationLabel(selectedRow.durationMs),
                ),
                ...(selectedRow.ttftMs === undefined
                  ? []
                  : [paneField(traceText('trace.field.ttftDuration'), durationLabel(selectedRow.ttftMs))]),
                ...(selectedRow.ttftMs === undefined || selectedRow.durationMs === undefined
                  ? []
                  : [
                      paneField(
                        traceText('trace.field.generationAfter'),
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
    meta?.controlFacts?.length
      ? createElement(
          'details',
          { 'data-testid': 'control-facts' },
          createElement('summary', null, traceText('trace.controls.title')),
          createElement(
            'ol',
            null,
            meta.controlFacts.map((fact) =>
              createElement(
                'li',
                { key: fact.seq, 'data-testid': 'control-fact' },
                createElement(
                  'span',
                  null,
                  `${traceText(('trace.controls.' + fact.action) as TraceMessageKey)} · ${traceText(('trace.controls.' + fact.outcome) as TraceMessageKey)} · ${fact.actor.id}`,
                ),
                createElement('time', { dateTime: fact.ts }, fact.ts),
                createElement('pre', null, JSON.stringify(fact.details, null, 2)),
              ),
            ),
          ),
        )
      : null,
    createElement(
      'div',
      { className: 'trace-toolbar', hidden: rows.length === 0 && !meta?.loop },
      ...(meta?.loop
        ? [
            createElement(
              'span',
              { className: 'trace-stat', key: 'session-loop' },
              traceText('trace.sessionLoop', { id: meta.loop.id, version: meta.loop.version }),
            ),
          ]
        : []),
      createElement(
        'div',
        { className: 'trace-stats' },
        ...traceStats(snapshot.turns).map(([label, value]) =>
          createElement('span', { className: 'trace-stat', key: label }, `${label} ${value}`),
        ),
        ...(meta?.hasEarlier
          ? [
              createElement(
                'span',
                { className: 'trace-stat trace-partial', key: 'partial' },
                traceText('trace.partial'),
              ),
            ]
          : []),
      ),
      createElement(
        'button',
        {
          className: 'trace-fold-all',
          type: 'button',
          disabled: focusActive || numberedTurns.length === 0,
          'aria-label': allTurnsCollapsed
            ? traceText('trace.expandTurnsLabel')
            : traceText('trace.collapseTurnsLabel'),
          onClick: toggleAllTurns,
        },
        allTurnsCollapsed ? traceText('trace.expandTurns') : traceText('trace.collapseTurns'),
      ),
      createElement(
        SettingsSelect,
        {
          className: 'trace-type-filter',
          'aria-label': traceText('trace.filter.label'),
          value: kindFilter,
          onChange: (event: import('react').ChangeEvent<HTMLSelectElement>) =>
            setKindFilter(event.currentTarget.value),
        },
        createElement('option', { value: 'all' }, traceText('trace.filter.all')),
        ...['user', 'assistant', 'tool', 'context', 'approval', 'compaction'].map((kind) =>
          createElement('option', { key: kind, value: kind }, traceText(BADGE_KEY[kind]!)),
        ),
      ),
      createElement(SettingsInput, {
        className: 'trace-search',
        type: 'search',
        placeholder: traceText('trace.search'),
        'aria-label': traceText('trace.searchLabel'),
        value: query,
        onInput: updateQuery,
      }),
    ),
    createElement(
      'div',
      {
        className: 'trace-gantt',
        role: 'group',
        'aria-label': traceText('trace.gantt.label'),
        hidden: rows.length === 0,
        ref: timelineRef,
      },
      createElement(
        'div',
        { className: 'trace-gantt-controls' },
        createElement('label', { htmlFor: 'trace-timeline-mode' }, traceText('trace.timeline.label')),
        createElement(
          SettingsSelect,
          {
            id: 'trace-timeline-mode',
            value: timelineMode,
            onChange: changeTimelineMode,
            'aria-label': traceText('trace.timeline.mode'),
          },
          createElement('option', { value: 'sequence' }, traceText('trace.timeline.sequence')),
          createElement('option', { value: 'duration' }, traceText('trace.timeline.duration')),
          createElement('option', { value: 'time' }, traceText('trace.timeline.time')),
          createElement('option', { value: 'actual' }, traceText('trace.timeline.actual')),
        ),
        createElement(
          'span',
          { className: 'trace-gantt-note' },
          timelineMode === 'sequence'
            ? traceText('trace.timeline.noteSequence')
            : timelineMode === 'duration'
              ? traceText('trace.timeline.noteDuration')
              : traceText('trace.timeline.noteTime'),
        ),
        ...(timelineRange
          ? [
              createElement(
                'button',
                {
                  className: 'trace-gantt-clear',
                  type: 'button',
                  onClick: () => setTimelineRange(null),
                  'aria-label': traceText('trace.timeline.clearLabel'),
                },
                traceText('trace.timeline.clear'),
              ),
            ]
          : []),
      ),
      ...(['input', 'model', 'tool'] as const).map((lane) =>
        createElement(
          'div',
          { className: 'trace-gantt-row', key: lane },
          createElement('span', { className: 'trace-gantt-label' }, laneName(lane)),
          createElement(
            'div',
            {
              className: 'trace-gantt-track',
              ref: lane === 'input' ? timelineTrackRef : undefined,
              tabIndex: lane === 'input' ? 0 : -1,
              role: 'group',
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
              'aria-label': traceText('trace.lane.aria', { lane: laneName(lane) }),
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
                const title = cluster ? traceText('trace.cluster', { n: unit.count }) : bar.title
                return createElement(targets.length && !compact ? 'button' : 'span', {
                  className: `trace-gantt-bar lane-${lane}${!cluster && bar.tone ? ` tone-${bar.tone}` : ''}${!cluster && bar.truncated ? ' truncated' : ''}${marker ? ' marker' : ''}${cluster ? ' cluster' : ''}`,
                  key: unit.key,
                  ...(targets.length && !compact
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
              traceText('trace.loadEarlier'),
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
                `${item.collapsed ? '▸' : '▾'} ${traceText('trace.turnHeader', {
                  turn: item.turn,
                  count: item.count,
                  folded: item.collapsed ? traceText('trace.turnFolded') : '',
                })}`,
              ),
            )
          const row = item.row
          const request = row.callUsage ? requestMetrics.get(row.callUsage.seq) : undefined
          const requestPrefix =
            request?.requestNumber.state === 'known'
              ? traceText('trace.requestPrefix', { n: request.requestNumber.value })
              : ''
          const children = toolHierarchy.childrenById.get(row.id) ?? []
          const toolDepth = row.kind === 'tool' ? Math.min(8, toolHierarchy.depthById.get(row.id) ?? 0) : 0
          const nested = row.kind === 'tool' && (children.length > 0 || toolDepth > 0)
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
            createElement(
              'span',
              { className: 'trace-step-mark' },
              item.showStep ? stepLabel(row.step) : undefined,
            ),
            createElement('span', { className: `trace-badge kind-${row.kind}` }, row.badge),
            createElement(
              'span',
              { className: 'trace-row-preview' },
              `${requestPrefix}${clip(row.preview, 160) || traceText('trace.emptyPreview')}${row.statusCode === 'completed' ? '' : ` · ${row.status}`}${row.errorCode ? ` · ${row.errorCode}` : ''}`,
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
                        ? traceText('trace.tool.expand', { source: row.source })
                        : traceText('trace.tool.collapse', { source: row.source }),
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
                traceText('trace.noResults'),
              ),
            ]
          : []),
      ),
      ...omitted.map((note) =>
        createElement(
          'p',
          { key: `omitted:${note.key}`, className: 'trace-truncated', role: 'note' },
          traceText('trace.omittedNote', { turn: note.turn, label: note.label }),
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
                'aria-label': traceText('trace.lightbox.close'),
                onClick: () => setLightbox(null),
              },
              '×',
            ),
            createElement('img', { src: lightbox.src, alt: lightbox.alt }),
          ),
        ]
      : []),
    createElement('p', { className: 'trace-empty', hidden: rows.length > 0 }, traceText('trace.empty')),
  )
})
