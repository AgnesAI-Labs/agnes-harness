// biome-ignore-all lint/a11y/useSemanticElements: the timeline lanes keep their div roles for pointer gestures and the virtual geometry.
import { Button } from '@agnes/web-ui'
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { traceText } from './trace-locale.js'
import type { GanttBar, TimelineRange } from './trace-model.js'
import { buildTraceTimelineDensity, pickTraceTimelineDensityMember } from './trace-timeline-density.js'

const laneName = (lane: 'input' | 'model' | 'tool'): string =>
  traceText(lane === 'input' ? 'trace.lane.input' : lane === 'model' ? 'trace.lane.model' : 'trace.lane.tool')
const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50
const orderedRange = (a: number, b: number): TimelineRange =>
  a <= b ? { start: a, end: b } : { start: b, end: a }
export const barIntersectsRange = (bar: GanttBar, range: TimelineRange): boolean =>
  bar.marker
    ? bar.domainStart >= range.start && bar.domainStart <= range.end
    : bar.domainStart < range.end && bar.domainEnd > range.start

/**
 * The time overview above the list: three lanes, drag to pick a range, scroll to zoom, right-drag
 * to pan, click a bar to open its record. The range and viewport are the trace's state.
 */
export function TraceGantt({
  hidden,
  compact,
  bars,
  timelineModel,
  viewportStart,
  viewportWidth,
  fullTimelineWidth,
  timelineRange,
  setTimelineRange,
  setTimelineViewport,
  selected,
  selectRow,
}: {
  hidden: boolean
  compact: boolean
  bars: readonly GanttBar[]
  timelineModel: { start: number; end: number }
  viewportStart: number
  viewportWidth: number
  fullTimelineWidth: number
  timelineRange: TimelineRange | null
  setTimelineRange(value: TimelineRange | null): void
  setTimelineViewport(
    value: TimelineRange | null | ((current: TimelineRange | null) => TimelineRange | null),
  ): void
  selected: string | undefined
  selectRow(id: string): void
}) {
  const [timelineDraft, setTimelineDraft] = useState<TimelineRange | null>(null)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const timelineTrackRef = useRef<HTMLDivElement | null>(null)
  const timelineGesture = useRef<{
    pointerId: number
    clientX: number
    anchor: number
    pan: boolean
    viewportStart: number
  } | null>(null)
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
  }, [bars.length, fullTimelineWidth, timelineModel.start, timelineModel.end, setTimelineViewport])
  const activeTimelineRange = timelineDraft ?? timelineRange
  const projectedPosition = (value: number): number => ((value - viewportStart) / viewportWidth) * 100

  return (
    <div
      className="trace-gantt"
      role="group"
      aria-label={traceText('trace.gantt.label')}
      hidden={hidden}
      ref={timelineRef}
    >
      {timelineRange ? (
        <div className="trace-gantt-controls">
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
        </div>
      ) : null}
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
  )
}
