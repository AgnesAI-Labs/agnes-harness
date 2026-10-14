import { Button, IconButton, Menu, SettingsInput } from '@agnes/web-ui'
import type { KeyboardEvent, RefObject } from 'react'
import { traceText } from './trace-locale.js'
import { BADGE_KEY, type TimelineMode } from './trace-model.js'

/** The order the type chips appear in; a kind with no records gets no chip. */
export const TRACE_CHIP_KINDS = [
  'user',
  'assistant',
  'tool',
  'approval',
  'ui',
  'control',
  'context',
  'compaction',
] as const

const TIMELINE_MODES: ReadonlyArray<[TimelineMode, Parameters<typeof traceText>[0]]> = [
  ['sequence', 'trace.timeline.sequence'],
  ['duration', 'trace.timeline.duration'],
  ['time', 'trace.timeline.time'],
  ['actual', 'trace.timeline.actual'],
]

/**
 * One toolbar row: the Loop and stats on the left, then type chips with counts (several can be on;
 * none means all), search with a match count and previous/next, fold-all, and a ⋯ menu that holds
 * the timeline mode.
 */
export function TraceToolbar({
  hidden,
  loop,
  stats,
  partial,
  counts,
  kinds,
  toggleKind,
  query,
  setQuery,
  matches,
  matchIndex,
  stepMatch,
  searchRef,
  allCollapsed,
  canFold,
  toggleAll,
  timelineMode,
  setTimelineMode,
}: {
  hidden: boolean
  loop?: { id: string; version: string } | undefined
  stats: ReadonlyArray<[string, string]>
  partial: boolean
  counts: ReadonlyMap<string, number>
  kinds: ReadonlySet<string>
  toggleKind(kind: string | undefined): void
  query: string
  setQuery(value: string): void
  matches: number
  matchIndex: number
  stepMatch(direction: 1 | -1): void
  searchRef: RefObject<HTMLInputElement>
  allCollapsed: boolean
  canFold: boolean
  toggleAll(): void
  timelineMode: TimelineMode
  setTimelineMode(mode: TimelineMode): void
}) {
  const chips = TRACE_CHIP_KINDS.filter((kind) => (counts.get(kind) ?? 0) > 0)
  return (
    <div className="trace-toolbar" hidden={hidden}>
      <div className="trace-toolbar-lead">
        {loop ? (
          <span className="trace-stat trace-loop" key="session-loop">
            {traceText('trace.sessionLoop', { id: loop.id, version: loop.version })}
          </span>
        ) : null}
        <div className="trace-stats">
          {stats.map(([label, value]) => (
            <span className="trace-stat" key={label}>
              {label} <b>{value}</b>
            </span>
          ))}
          {partial ? (
            <span className="trace-stat trace-partial" key="partial">
              {traceText('trace.partial')}
            </span>
          ) : null}
        </div>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of toggle buttons; fieldset would add a legend and form semantics. */}
      <div className="trace-chips" role="group" aria-label={traceText('trace.chips.label')}>
        <Button
          appearance="ghost"
          size="small"
          htmlType="button"
          className="trace-chip"
          data-kind="all"
          aria-pressed={kinds.size === 0}
          onClick={() => toggleKind(undefined)}
        >
          {traceText('trace.chip.all')}
        </Button>
        {chips.map((kind) => {
          const label = traceText(BADGE_KEY[kind] ?? 'trace.badge.assistant')
          const count = counts.get(kind) ?? 0
          return (
            <Button
              appearance="ghost"
              size="small"
              htmlType="button"
              key={kind}
              className="trace-chip"
              data-kind={kind}
              aria-pressed={kinds.has(kind)}
              aria-label={traceText('trace.chip.aria', { label, n: count })}
              onClick={() => toggleKind(kind)}
            >
              <i className={`trace-chip-dot kind-${kind}`} aria-hidden="true" />
              {label}
              <small>{count}</small>
            </Button>
          )
        })}
      </div>
      <div className="trace-search-box">
        <SettingsInput
          ref={searchRef}
          className="trace-search"
          type="search"
          placeholder={traceText('trace.search')}
          aria-label={traceText('trace.searchLabel')}
          value={query}
          onInput={(event: { currentTarget: HTMLInputElement }) => setQuery(event.currentTarget.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              stepMatch(event.shiftKey ? -1 : 1)
            }
            if (event.key === 'Escape' && query) {
              event.preventDefault()
              setQuery('')
            }
          }}
        />
        {query.trim() ? (
          <>
            <span className="trace-search-count" role="status" data-testid="trace-search-count">
              {matches
                ? traceText('trace.search.count', { k: matchIndex + 1, n: matches })
                : traceText('trace.search.none')}
            </span>
            <IconButton
              name="arrow-up"
              className="trace-search-step"
              label={traceText('trace.search.previous')}
              disabled={matches === 0}
              onClick={() => stepMatch(-1)}
            />
            <IconButton
              name="arrow-down"
              className="trace-search-step"
              label={traceText('trace.search.next')}
              disabled={matches === 0}
              onClick={() => stepMatch(1)}
            />
          </>
        ) : null}
      </div>
      <IconButton
        name={allCollapsed ? 'chevron-down' : 'chevron-up'}
        className="trace-fold-all"
        disabled={!canFold}
        label={allCollapsed ? traceText('trace.expandTurnsLabel') : traceText('trace.collapseTurnsLabel')}
        onClick={toggleAll}
      />
      <Menu
        label={traceText('trace.more')}
        items={TIMELINE_MODES.map(([mode, key]) => ({
          id: `timeline-${mode}`,
          testId: `trace-timeline-${mode}`,
          label: `${mode === timelineMode ? '✓ ' : ''}${traceText('trace.timeline.item', { mode: traceText(key) })}`,
          onSelect: () => setTimelineMode(mode),
        }))}
        trigger={
          <IconButton
            name="ellipsis"
            className="trace-toolbar-more"
            data-testid="trace-toolbar-more"
            label={traceText('trace.more')}
          />
        }
      />
    </div>
  )
}
