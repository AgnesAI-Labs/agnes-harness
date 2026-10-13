// biome-ignore-all lint/a11y/useSemanticElements: preserve public trace div roles and the virtual list geometry during the JSX migration.
import type { SessionControlFact } from '@agnes/protocol/gen/agnes-v1'
import { Button, EmptyState, Icon, IconButton, SettingsInput, SettingsSelect } from '@agnes/web-ui'
import { TraceControlFacts } from './trace-control-facts.js'
import { type InspectorPane, type ToolDetailState, TraceInspector } from './trace-inspector.js'
import {
  BADGE_KEY,
  buildGantt,
  buildTraceRows,
  clip,
  type GanttBar,
  type TimelineMode,
  type TimelineRange,
  type TraceRow,
  traceRowBuilder,
  traceStats,
  traceStepLabel,
  truncations,
} from './trace-model.js'

export { buildTraceRows, durationLabel, type TraceRow, traceRowBuilder } from './trace-model.js'

import type { ToolCall, ToolResult, UINode, UITurn } from '@agnes/protocol'
import {
  type ForwardedRef,
  forwardRef,
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
  loop?: {
    id: string
    version: string
  }
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
  ) => Promise<{
    call: ToolCall
    result?: ToolResult
  }>
}
type TraceListItem =
  | {
      key: 'load-earlier'
      kind: 'header'
      loadEarlier: () => void
    }
  | {
      key: string
      kind: 'header'
      turn: number
      count: number
      collapsed: boolean
    }
  | {
      key: string
      kind: 'row'
      row: TraceRow
      showStep: boolean
    }
const TRACE_ROW_HEIGHT = 32
const TRACE_HEADER_HEIGHT = 33
const TRACE_VIRTUAL_THRESHOLD = 100
export interface TraceProps {
  root: HTMLElement
  options: Omit<TracePanelOptions, 'root'>
}
const laneName = (lane: 'input' | 'model' | 'tool'): string =>
  traceText(lane === 'input' ? 'trace.lane.input' : lane === 'model' ? 'trace.lane.model' : 'trace.lane.tool')
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
  type Snapshot = {
    nodes: readonly UINode[]
    turns: readonly UITurn[]
    meta?: TraceMeta | undefined
  }
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
  const [lightbox, setLightbox] = useState<{
    src: string
    alt: string
  } | null>(null)
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
  const pendingListPosition = useRef<{
    anchor: TraceVirtualAnchor | undefined
    followTail: boolean
  } | null>(null)
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
    const result: Array<{
      turn: number | undefined
      rows: TraceRow[]
    }> = []
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
      const turnId = (
        event as CustomEvent<{
          turnId?: string
        }>
      ).detail?.turnId
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

  return (
    <div
      id="trace-content"
      style={{ display: 'contents' }}
      data-agnes-region-owner="builtin"
      data-agnes-region-unit="trace"
    >
      {meta?.controlFacts?.length ? <TraceControlFacts facts={meta.controlFacts} /> : null}
      <div className="trace-toolbar" hidden={rows.length === 0 && !meta?.loop}>
        {meta?.loop ? (
          <span className="trace-stat" key="session-loop">
            {traceText('trace.sessionLoop', { id: meta.loop.id, version: meta.loop.version })}
          </span>
        ) : null}
        <div className="trace-stats">
          {traceStats(snapshot.turns).map(([label, value]) => (
            <span className="trace-stat" key={label}>{`${label} ${value}`}</span>
          ))}
          {meta?.hasEarlier ? (
            <span className="trace-stat trace-partial" key="partial">
              {traceText('trace.partial')}
            </span>
          ) : null}
        </div>
        <Button
          appearance="ghost"
          size="small"
          className="trace-fold-all"
          htmlType="button"
          disabled={focusActive || numberedTurns.length === 0}
          aria-label={
            allTurnsCollapsed ? traceText('trace.expandTurnsLabel') : traceText('trace.collapseTurnsLabel')
          }
          onClick={toggleAllTurns}
        >
          {allTurnsCollapsed ? traceText('trace.expandTurns') : traceText('trace.collapseTurns')}
        </Button>
        <SettingsSelect
          className="trace-type-filter"
          aria-label={traceText('trace.filter.label')}
          value={kindFilter}
          onChange={(event: import('react').ChangeEvent<HTMLSelectElement>) =>
            setKindFilter(event.currentTarget.value)
          }
        >
          <option value="all">{traceText('trace.filter.all')}</option>
          {['user', 'assistant', 'tool', 'context', 'approval', 'compaction'].map((kind) => (
            <option key={kind} value={kind}>
              {traceText(BADGE_KEY[kind]!)}
            </option>
          ))}
        </SettingsSelect>
        <SettingsInput
          className="trace-search"
          type="search"
          placeholder={traceText('trace.search')}
          aria-label={traceText('trace.searchLabel')}
          value={query}
          onInput={updateQuery}
        />
      </div>
      <div
        className="trace-gantt"
        role="group"
        aria-label={traceText('trace.gantt.label')}
        hidden={rows.length === 0}
        ref={timelineRef}
      >
        <div className="trace-gantt-controls">
          <label htmlFor="trace-timeline-mode">{traceText('trace.timeline.label')}</label>
          <SettingsSelect
            id="trace-timeline-mode"
            value={timelineMode}
            onChange={changeTimelineMode}
            aria-label={traceText('trace.timeline.mode')}
          >
            <option value="sequence">{traceText('trace.timeline.sequence')}</option>
            <option value="duration">{traceText('trace.timeline.duration')}</option>
            <option value="time">{traceText('trace.timeline.time')}</option>
            <option value="actual">{traceText('trace.timeline.actual')}</option>
          </SettingsSelect>
          <span className="trace-gantt-note">
            {timelineMode === 'sequence'
              ? traceText('trace.timeline.noteSequence')
              : timelineMode === 'duration'
                ? traceText('trace.timeline.noteDuration')
                : traceText('trace.timeline.noteTime')}
          </span>
          {timelineRange ? (
            <Button
              appearance="ghost"
              size="small"
              className="trace-gantt-clear"
              htmlType="button"
              onClick={() => setTimelineRange(null)}
              aria-label={traceText('trace.timeline.clearLabel')}
            >
              {traceText('trace.timeline.clear')}
            </Button>
          ) : null}
        </div>
        {(['input', 'model', 'tool'] as const).map((lane) => (
          <div className="trace-gantt-row" key={lane}>
            <span className="trace-gantt-label">{laneName(lane)}</span>
            <div
              className="trace-gantt-track agh-touch-target"
              ref={lane === 'input' ? timelineTrackRef : undefined}
              tabIndex={lane === 'input' ? 0 : -1}
              role="group"
              onPointerDown={timelinePointerDown}
              onPointerMove={timelinePointerMove}
              onPointerUp={timelinePointerUp}
              onPointerCancel={timelinePointerCancel}
              onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => event.preventDefault()}
              onDoubleClick={() => setTimelineRange(null)}
              onKeyDown={(event: { key: string; preventDefault: () => void }) => {
                if (event.key === 'Escape' && timelineRange) {
                  event.preventDefault()
                  setTimelineRange(null)
                }
              }}
              aria-label={traceText('trace.lane.aria', { lane: laneName(lane) })}
            >
              {activeTimelineRange ? (
                <span
                  key="selection"
                  className="trace-gantt-selection"
                  aria-hidden={true}
                  style={{
                    left: `${projectedPosition(activeTimelineRange.start)}%`,
                    width: `${((activeTimelineRange.end - activeTimelineRange.start) / viewportWidth) * 100}%`,
                  }}
                />
              ) : null}
              {timelineUnits
                .filter((unit) => unit.lane === lane)
                .map((unit) => {
                  const bar = unit.members[0]
                  if (!bar) return null
                  const cluster = unit.kind === 'cluster'
                  const marker = cluster ? unit.domainEnd <= unit.domainStart : bar.marker
                  const targets = unit.members.filter((member) => member.targetId)
                  const title = cluster ? traceText('trace.cluster', { n: unit.count }) : bar.title
                  const TimelineBar = targets.length && !compact ? Button : 'span'
                  return (
                    <TimelineBar
                      className={`trace-gantt-bar lane-${lane}${!cluster && bar.tone ? ` tone-${bar.tone}` : ''}${!cluster && bar.truncated ? ' truncated' : ''}${marker ? ' marker' : ''}${cluster ? ' cluster' : ''}`}
                      key={unit.key}
                      {...(targets.length && !compact
                        ? {
                            htmlType: 'button' as const,
                            appearance: 'ghost' as const,
                            size: 'small' as const,
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
                                ? clampPercent(
                                    ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100,
                                  ) / 100
                                : 0.5
                              const point = viewportStart + fraction * viewportWidth
                              const chosen = cluster
                                ? pickTraceTimelineDensityMember({ ...unit, members: targets }, point)
                                : bar
                              if (chosen.targetId) selectRow(chosen.targetId)
                            },
                          }
                        : { 'aria-hidden': true })}
                      style={{
                        left: marker
                          ? `min(${projectedPosition(unit.domainStart)}%, calc(100% - 6px))`
                          : `${projectedPosition(unit.domainStart)}%`,
                        width: cluster
                          ? `${((unit.domainEnd - unit.domainStart) / viewportWidth) * 100}%`
                          : `${(bar.width * fullTimelineWidth) / viewportWidth}%`,
                      }}
                      title={title}
                    />
                  )
                })}
            </div>
          </div>
        ))}
      </div>
      <div className="trace-body" hidden={rows.length === 0}>
        <div
          className="trace-list"
          role="list"
          ref={listRef}
          onScroll={(event: { currentTarget: HTMLDivElement }) => {
            if (!virtualized) return
            const next = getTraceVirtualWindow(
              listLayout,
              event.currentTarget.scrollTop,
              listViewportHeight,
              256,
            )
            if (next.start !== listWindow.start || next.end !== listWindow.end)
              setListScrollTop(event.currentTarget.scrollTop)
          }}
        >
          {virtualized && listWindow.topPadding ? (
            <div
              key="top-spacer"
              className="trace-list-spacer"
              aria-hidden={true}
              style={{ height: `${listWindow.topPadding}px` }}
            />
          ) : null}
          {listItems.slice(listWindow.start, listWindow.end).map((item) => {
            if (item.kind === 'header' && 'loadEarlier' in item)
              return (
                <Button
                  appearance="ghost"
                  size="small"
                  key={item.key}
                  className="trace-load-earlier"
                  htmlType="button"
                  onClick={() => {
                    const list = listRef.current
                    earlierPosition.current = {
                      sessionId: snapshot.meta?.sessionId,
                      firstNodeId: snapshot.nodes[0]?.id,
                      anchor: list ? captureTraceVirtualAnchor(listLayout, list.scrollTop) : undefined,
                    }
                    item.loadEarlier()
                  }}
                >
                  {traceText('trace.loadEarlier')}
                </Button>
              )
            if (item.kind === 'header')
              return (
                <div className="trace-turn-header" role="listitem" key={item.key}>
                  <Button
                    appearance="ghost"
                    size="small"
                    className="trace-turn-toggle"
                    htmlType="button"
                    disabled={focusActive}
                    aria-expanded={!item.collapsed}
                    onClick={() => toggleTurn(item.turn)}
                  >{`${item.collapsed ? '▸' : '▾'} ${traceText('trace.turnHeader', {
                    turn: item.turn,
                    count: item.count,
                    folded: item.collapsed ? traceText('trace.turnFolded') : '',
                  })}`}</Button>
                </div>
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
            const rowButton = (
              <Button
                appearance="ghost"
                size="small"
                className="trace-row"
                htmlType="button"
                role={nested ? undefined : 'listitem'}
                data-trace-row-id={row.id}
                aria-current={row.id === selected ? 'true' : undefined}
                onClick={() => selectRow(row.id)}
                {...(nested ? { style: { paddingLeft: `${24 + toolDepth * 16}px` } } : {})}
              >
                <span className="trace-step-mark">
                  {item.showStep ? traceStepLabel(row.step) : undefined}
                </span>
                <span className={`trace-badge kind-${row.kind}`}>{row.badge}</span>
                <span className="trace-row-preview">{`${requestPrefix}${clip(row.preview, 160) || traceText('trace.emptyPreview')}${row.statusCode === 'completed' ? '' : ` · ${row.status}`}${row.errorCode ? ` · ${row.errorCode}` : ''}`}</span>
              </Button>
            )
            if (!nested)
              return (
                <div key={item.key} className="trace-row-entry">
                  {rowButton}
                </div>
              )
            return (
              <div key={item.key} className="trace-tool-entry" role="listitem">
                {children.length ? (
                  <Button
                    appearance="ghost"
                    size="small"
                    htmlType="button"
                    className="trace-tool-toggle"
                    style={{ left: `${4 + toolDepth * 16}px` }}
                    aria-label={
                      collapsedTools.has(row.id)
                        ? traceText('trace.tool.expand', { source: row.source })
                        : traceText('trace.tool.collapse', { source: row.source })
                    }
                    aria-expanded={focusActive || !collapsedTools.has(row.id)}
                    disabled={focusActive}
                    onClick={() => toggleTool(row.id)}
                  >
                    {collapsedTools.has(row.id) && !focusActive ? '▸' : '▾'}
                  </Button>
                ) : null}
                {rowButton}
              </div>
            )
          })}
          {virtualized && listWindow.bottomPadding ? (
            <div
              key="bottom-spacer"
              className="trace-list-spacer"
              aria-hidden={true}
              style={{ height: `${listWindow.bottomPadding}px` }}
            />
          ) : null}
          {rows.length > 0 && visibleRows.length === 0 ? (
            <p key="no-results" className="trace-no-results" role="status">
              {traceText('trace.noResults')}
            </p>
          ) : null}
        </div>
        {omitted.map((note) => (
          <p key={`omitted:${note.key}`} className="trace-truncated" role="note">
            {traceText('trace.omittedNote', { turn: note.turn, label: note.label })}
          </p>
        ))}
        <TraceInspector
          selectedRow={selectedRow}
          compact={compact}
          closeInspector={closeInspector}
          options={options}
          snapshot={snapshot}
          selectedToolKey={selectedToolKey}
          activeToolDetail={activeToolDetail}
          pane={pane}
          selectPane={selectPane}
          selectedUserNode={selectedUserNode}
          selectedRequest={selectedRequest}
          setLightbox={setLightbox}
        />
      </div>
      {lightbox ? (
        <div
          className="trace-lightbox"
          role="dialog"
          aria-modal={true}
          aria-label={lightbox.alt}
          onKeyDown={(event: { key: string; preventDefault: () => void }) => {
            if (event.key === 'Escape') setLightbox(null)
            if (event.key === 'Tab') {
              event.preventDefault()
              root.querySelector<HTMLButtonElement>('.trace-lightbox-close')?.focus()
            }
          }}
        >
          <IconButton
            name="x"
            className="trace-lightbox-close"
            label={traceText('trace.lightbox.close')}
            onClick={() => setLightbox(null)}
          />
          <img src={lightbox.src} alt={lightbox.alt} />
        </div>
      ) : null}
      <EmptyState
        className="trace-empty"
        hidden={rows.length > 0}
        icon={<Icon name="activity" />}
        title={traceText('trace.empty')}
        description=""
      />
    </div>
  )
})
