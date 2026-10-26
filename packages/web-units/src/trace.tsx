// biome-ignore-all lint/a11y/useSemanticElements: preserve public trace div roles and the virtual list geometry during the JSX migration.
import type { SessionControlFact } from '@agnes/protocol/gen/agnes-v1'
import { Button, EmptyState, Icon } from '@agnes/web-ui'
import { authoringRow, resolveFactRow } from './trace-focus.js'
import { barIntersectsRange, TraceGantt } from './trace-gantt.js'
import { buildGantt, truncations } from './trace-gantt-model.js'
import { defaultPane, type InspectorPane, type ToolDetailState, TraceInspector } from './trace-inspector.js'
import { TraceLightbox } from './trace-inspector-parts.js'
import { TraceListRow, traceRowHaystack } from './trace-list-row.js'
import {
  buildControlRows,
  buildTraceRows,
  clip,
  durationLabel,
  placeTraceRowsInTurns,
  type TimelineMode,
  type TimelineRange,
  type TraceRow,
  traceRowBuilder,
  traceStats,
} from './trace-model.js'
import type { LoadArtifact, ReadFactChain } from './trace-provenance.js'
import { TraceSplitter, useInspectorWidth } from './trace-splitter.js'
import { TraceToolbar } from './trace-toolbar.js'
import { createTraceViewMemory } from './trace-view-memory.js'

export { buildTraceRows, durationLabel, type TraceRow, traceRowBuilder } from './trace-model.js'

import type { ToolCall, ToolResult, UINode, UITurn } from '@agnes/protocol'
import {
  type ForwardedRef,
  forwardRef,
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
import { traceLocale, traceText } from './trace-locale.js'
import { buildTraceRequestMetrics } from './trace-request-metrics.js'
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
  /** Opens the trace on the record a fact-chain link names, with its «Provenance» tab showing. */
  focusFact?(params: import('@agnes/protocol').FactChainParams): boolean
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
  /** Downloads an artifact a record produced, through the session's resource service. */
  loadArtifact?: LoadArtifact
  /** Reads a request's provenance for the inspector's «Provenance» tab; the trace never opens the workbench. */
  readFactChain?: ReadFactChain
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
      prompt?: string | undefined
      durationMs?: number | undefined
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
  // The view is chosen per session; `decided` is the session (and whether it had records) it was
  // last chosen for, so a new session or one with nothing recorded opens on the conversation.
  const memory = useRef(createTraceViewMemory(store, open.current)).current
  const decided = useRef<{ key: string | undefined; records: boolean } | undefined>(undefined)
  type Snapshot = {
    nodes: readonly UINode[]
    turns: readonly UITurn[]
    meta?: TraceMeta | undefined
  }
  const [snapshot, setSnapshot] = useState<Snapshot>({ nodes: [], turns: [] })
  // A switched session remounts this panel empty; the empty state waits for the first record set.
  const [fed, setFed] = useState(false)
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
  // What is typed stays as typed; matching uses its trimmed, lower-case form.
  const [typedQuery, setQuery] = useState('')
  const query = typedQuery.trim().toLowerCase()
  const [kinds, setKinds] = useState<ReadonlySet<string>>(new Set())
  // The current match is remembered by row, so a chip, a timeline range or new records cannot move it.
  const [matchId, setMatchId] = useState<string | undefined>(undefined)
  const searchRef = useRef<HTMLInputElement>(null)
  const inspectorWidth = useInspectorWidth()
  const [selected, setSelected] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!compact || !selected) return
    const previous = document.activeElement
    root.querySelector<HTMLButtonElement>('.trace-inspector-close')?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [compact, selected, root])
  const [pane, setPane] = useState<InspectorPane>('content')
  const [focus, setFocus] = useState<import('@agnes/protocol').FactChainAnchor | undefined>(undefined)
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
  const locale = useSyncExternalStore((listener) => {
    window.addEventListener('agnes:locale-changed', listener)
    return () => window.removeEventListener('agnes:locale-changed', listener)
  }, traceLocale)
  // buildTraceRows reads the document language itself. locale is only the subscription snapshot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: locale changes the formatted row text
  const rows = useMemo(() => {
    const built = traceRowBuilder.build(snapshot.nodes, snapshot.turns)
    const controls = buildControlRows(snapshot.meta?.controlFacts ?? [])
    const all = controls.length ? [...built, ...controls].sort((a, b) => a.seq - b.seq) : built
    return placeTraceRowsInTurns(all, snapshot.turns)
  }, [snapshot.nodes, snapshot.turns, snapshot.meta?.controlFacts, locale])
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
  const wantsToolDetail = pane === 'args' || pane === 'result' || pane === 'input' || pane === 'output'
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
    const changed = open.current !== next
    open.current = next
    if (changed && persist) {
      root.dataset.viewEnter = 'right'
      if (options.conversation) options.conversation.dataset.viewEnter = 'left'
    }
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
    if (persist) {
      store.setItem(TRACE_PANEL_STORAGE_KEY, next ? 'open' : 'closed')
      memory.remember(decided.current?.key, next)
    }
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
      root.removeAttribute('data-view-enter')
      options.conversation?.removeAttribute('data-view-enter')
    }
  }, [options.chatToggle, options.toggle, options.conversation, root])
  useImperativeHandle(
    ref,
    () => ({
      render(nodes, turns = [], meta) {
        flushSync(() => setFed(true))
        const key = meta?.sessionId
        const records = nodes.length > 0
        const last = decided.current
        if (!last || last.key !== key || (!last.records && records)) {
          decided.current = { key, records }
          const next = memory.viewFor(key, records)
          if (next !== open.current) applyOpenRef.current(next, false)
        }
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
      focusFact(params) {
        const value = latest.current ?? currentSnapshot.current
        if (value.meta?.sessionId !== params.sessionId) return false
        applyOpenRef.current(true, true)
        const placed = placeTraceRowsInTurns(buildTraceRows(value.nodes, value.turns), value.turns)
        const reveal = (id: string): void => {
          flushSync(() => {
            setTimelineRange(null)
            setTimelineViewport(null)
            setLightbox(null)
          })
          selectRowRef.current?.(id)
          flushSync(() => {
            setFocus(params.anchor)
            setPane('source')
          })
        }
        const id = resolveFactRow(placed, value.nodes, params.anchor)
        if (id) {
          reveal(id)
          return true
        }
        if (params.anchor.kind !== 'authoring' || !options.readFactChain) return false
        options.readFactChain(params).then(
          (result) => {
            const target = authoringRow(placed, result)
            if (target) reveal(target)
          },
          () => undefined,
        )
        return true
      },
      isOpen() {
        return open.current
      },
    }),
    [options.readFactChain, memory],
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
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1)
    return counts
  }, [rows])
  // Type chips and a timeline range narrow the list; search only marks and steps through matches.
  const visibleRows = useMemo(
    () =>
      rows.filter((row) => {
        if (kinds.size && !kinds.has(row.kind)) return false
        if (rangeIds && !rangeIds.has(row.id)) return false
        if (!query && !timelineRange && isTraceRowHiddenByTool(toolHierarchy, row.id, collapsedTools))
          return false
        return true
      }),
    [rows, rangeIds, query, timelineRange, toolHierarchy, collapsedTools, kinds],
  )
  const matches = useMemo(
    () =>
      query ? visibleRows.filter((row) => traceRowHaystack(row).includes(query)).map((row) => row.id) : [],
    [visibleRows, query],
  )
  const matchIndex = Math.max(0, matchId === undefined ? 0 : matches.indexOf(matchId))
  const currentMatch = matches[matchIndex]
  const matchSet = useMemo(() => new Set(matches), [matches])
  // One group per turn, in the order the turns first appear; rows are already placed contiguously.
  const groups = useMemo(() => {
    const result: Array<{ turn: number | undefined; rows: TraceRow[] }> = []
    const byTurn = new Map<number, { turn: number | undefined; rows: TraceRow[] }>()
    for (const row of visibleRows) {
      const previous = result[result.length - 1]
      const existing = row.turn === undefined ? undefined : byTurn.get(row.turn)
      if (existing) existing.rows.push(row)
      else if (previous && previous.turn === row.turn) previous.rows.push(row)
      else {
        const group = { turn: row.turn, rows: [row] }
        result.push(group)
        if (row.turn !== undefined) byTurn.set(row.turn, group)
      }
    }
    return result
  }, [visibleRows])
  const turnPrompts = useMemo(() => {
    const prompts = new Map<number, string>()
    for (const row of rows)
      if (row.turn !== undefined && !prompts.has(row.turn) && (row.kind === 'user' || row.kind === 'control'))
        prompts.set(row.turn, row.text)
    return prompts
  }, [rows])
  const focusActive = Boolean(query || timelineRange || kinds.size)
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
          prompt: turnPrompts.get(group.turn),
          durationMs: snapshot.turns.find((turn) => turn.turn === group.turn)?.durationMs,
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
  }, [groups, collapsedTurns, focusActive, snapshot.meta, snapshot.turns, turnPrompts])
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
          setKinds(new Set())
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
        setFocus(undefined)
        if (revealBar) {
          const start = Math.max(
            timelineModel.start,
            Math.min(timelineModel.end - viewportWidth, bar.domainStart - viewportWidth / 2),
          )
          setTimelineViewport({ start, end: start + viewportWidth })
        }
        setLightbox(null)
        // A failed tool opens on its result, where the error is.
        setPane(defaultPane(rows.find((row) => row.id === id)))
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
      const target = placeTraceRowsInTurns(buildTraceRows(active.nodes, active.turns), active.turns)
        .filter((row) => row.turn === turn.turn)
        .findLast((row) => row.kind === 'assistant')
      if (!target) return
      options.toggle.click()
      selectRow(target.id)
      flushSync(() => setPane('source'))
    }
    conversation.addEventListener('agnes:trace-turn', jump)
    return () => conversation.removeEventListener('agnes:trace-turn', jump)
  }, [options.conversation, options.toggle, snapshot, selectRow])
  selectRowRef.current = selectRow
  const closeInspector = (): void => {
    const previous = selected
    flushSync(() => {
      setSelected(undefined)
      setLightbox(null)
    })
    if (previous) {
      revealRow(previous)
      root.querySelector<HTMLElement>(`.trace-row[data-trace-row-id="${CSS.escape(previous)}"]`)?.focus()
    }
  }
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
  const changeTimelineMode = (mode: TimelineMode): void => {
    setTimelineMode(mode)
    setTimelineRange(null)
    setTimelineViewport(null)
  }
  const toggleKind = (kind: string | undefined): void =>
    setKinds((current) => {
      if (kind === undefined) return new Set()
      const next = new Set(current)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  const revealRow = (id: string): void => {
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
    root.querySelector<HTMLElement>(`.trace-row[data-trace-row-id="${CSS.escape(id)}"]`)?.scrollIntoView?.({
      block: 'nearest',
    })
  }
  const stepMatch = (direction: 1 | -1): void => {
    if (!matches.length) return
    const next = (matchIndex + direction + matches.length) % matches.length
    const id = matches[next]
    flushSync(() => setMatchId(id))
    if (id) revealRow(id)
  }
  // ⌘F / Ctrl+F finds in the trace while it is the visible view.
  useEffect(() => {
    const find = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f' || root.hidden) return
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    document.addEventListener('keydown', find)
    return () => document.removeEventListener('keydown', find)
  }, [root])

  return (
    <div
      id="trace-content"
      style={{ display: 'contents' }}
      data-agnes-region-owner="builtin"
      data-agnes-region-unit="trace"
    >
      <TraceToolbar
        hidden={rows.length === 0 && !meta?.loop}
        loop={meta?.loop}
        stats={traceStats(snapshot.turns)}
        partial={Boolean(meta?.hasEarlier)}
        counts={kindCounts}
        kinds={kinds}
        toggleKind={toggleKind}
        query={typedQuery}
        setQuery={(value) => {
          setQuery(value)
          setMatchId(undefined)
        }}
        matches={matches.length}
        matchIndex={matchIndex}
        stepMatch={stepMatch}
        searchRef={searchRef}
        allCollapsed={allTurnsCollapsed}
        canFold={!focusActive && numberedTurns.length > 0}
        toggleAll={toggleAllTurns}
        timelineMode={timelineMode}
        setTimelineMode={changeTimelineMode}
      />
      <TraceGantt
        hidden={rows.length === 0}
        compact={compact}
        bars={bars}
        timelineModel={timelineModel}
        viewportStart={viewportStart}
        viewportWidth={viewportWidth}
        fullTimelineWidth={fullTimelineWidth}
        timelineRange={timelineRange}
        setTimelineRange={setTimelineRange}
        setTimelineViewport={setTimelineViewport}
        selected={selected}
        selectRow={selectRow}
      />
      <div
        className="trace-body"
        hidden={rows.length === 0}
        style={
          selectedRow && !compact
            ? { gridTemplateColumns: `minmax(0, 1fr) auto ${inspectorWidth.width}px` }
            : undefined
        }
      >
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
              // A list holds only items: the action that loads earlier records is one of them.
              return (
                <div key={item.key} role="listitem">
                  <Button
                    appearance="ghost"
                    size="small"
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
                </div>
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
                    aria-label={traceText('trace.turnHeader', {
                      turn: item.turn,
                      count: item.count,
                      folded: item.collapsed ? traceText('trace.turnFolded') : '',
                    })}
                    onClick={() => toggleTurn(item.turn)}
                  >
                    <Icon name={item.collapsed ? 'chevron-right' : 'chevron-down'} size={16} />
                    <b>{traceText('trace.turn.title', { turn: item.turn })}</b>
                    {item.prompt ? (
                      <span className="trace-turn-prompt">
                        {traceText('trace.turn.prompt', { text: clip(item.prompt, 80) })}
                      </span>
                    ) : null}
                    <span className="trace-turn-meta">
                      {[
                        traceText('trace.turn.count', { n: item.count }),
                        item.durationMs === undefined ? '' : durationLabel(item.durationMs),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </Button>
                </div>
              )
            const row = item.row
            const children = toolHierarchy.childrenById.get(row.id) ?? []
            const toolDepth = row.kind === 'tool' ? Math.min(8, toolHierarchy.depthById.get(row.id) ?? 0) : 0
            const nested = row.kind === 'tool' && (children.length > 0 || toolDepth > 0)
            const rowButton = (
              <TraceListRow
                row={row}
                showStep={item.showStep}
                selected={row.id === selected}
                current={row.id === currentMatch}
                match={matchSet.has(row.id)}
                query={query}
                depth={nested ? toolDepth : 0}
                listItem={!nested}
                onSelect={() => selectRow(row.id)}
              />
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
          {omitted.map((note) => (
            <p key={`omitted:${note.key}`} className="trace-truncated" role="note">
              {traceText('trace.omittedNote', { turn: note.turn, label: note.label })}
            </p>
          ))}
        </div>
        {selectedRow && !compact ? (
          <TraceSplitter
            width={inspectorWidth.width}
            onChange={inspectorWidth.set}
            onReset={inspectorWidth.reset}
          />
        ) : null}
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
          focus={focus}
        />
      </div>
      {lightbox ? <TraceLightbox image={lightbox} root={root} close={() => setLightbox(null)} /> : null}
      <EmptyState
        className="trace-empty"
        hidden={rows.length > 0 || !fed}
        icon={<Icon name="activity" />}
        title={traceText('trace.empty')}
        description=""
      />
    </div>
  )
})
