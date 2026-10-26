import { Button, Icon } from '@agnes/web-ui'
import type { ReactNode } from 'react'
import { traceText } from './trace-locale.js'
import { clip, durationLabel, type TraceRow, traceStepLabel } from './trace-model.js'

/** Wraps each case-insensitive occurrence of the query in <mark>. */
export function highlight(text: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase()
  if (!needle) return text
  const parts: ReactNode[] = []
  const hay = text.toLowerCase()
  let from = 0
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

/** What a search looks at for one row; the raw record counts too, even where it is not shown. */
export const traceRowHaystack = (row: TraceRow): string =>
  `${row.badge} ${row.step ?? ''} ${row.text} ${row.secondary ?? ''} ${row.preview} ${row.raw} ${row.source} ${row.errorCode ?? ''}`.toLowerCase()

const STATUS_ICON = {
  completed: 'circle-check',
  failed: 'circle-alert',
  running: 'clock',
  waiting: 'clock',
} as const
const SHOWS_STATUS = new Set(['assistant', 'tool', 'ui', 'control'])

/** One list line: step, kind, what happened (with matches marked), then status and time on the right. */
export function TraceListRow({
  row,
  showStep,
  selected,
  current,
  match,
  query,
  depth,
  listItem,
  onSelect,
}: {
  row: TraceRow
  showStep: boolean
  selected: boolean
  current: boolean
  /** A search hit that is not the current one: the row carries a weak flag so hits in hidden text still show. */
  match?: boolean
  query: string
  depth: number
  listItem: boolean
  onSelect(): void
}) {
  const status = SHOWS_STATUS.has(row.kind)
    ? STATUS_ICON[row.statusCode as keyof typeof STATUS_ICON]
    : row.statusCode === 'failed'
      ? STATUS_ICON.failed
      : undefined
  const timed =
    (row.kind === 'tool' || row.kind === 'assistant') &&
    (row.durationMs !== undefined || row.statusCode === 'running')
  return (
    <Button
      appearance="ghost"
      size="small"
      className="trace-row"
      htmlType="button"
      role={listItem ? 'listitem' : undefined}
      data-trace-row-id={row.id}
      data-match={current ? 'current' : match ? 'hit' : undefined}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      {...(depth > 0 ? { style: { paddingLeft: `${24 + depth * 16}px` } } : {})}
    >
      <span className="trace-step-mark">{showStep ? traceStepLabel(row.step) : undefined}</span>
      <span className={`trace-badge kind-${row.kind}`}>{row.badge}</span>
      <span className="trace-row-preview">
        <span className="trace-row-text">
          {highlight(clip(row.text, 200), query) || traceText('trace.emptyPreview')}
        </span>
        {row.secondary ? (
          <span className="trace-preview-raw">{highlight(clip(row.secondary, 160), query)}</span>
        ) : null}
        {row.errorCode ? (
          <span className="trace-preview-status" data-status="failed">{` · ${row.errorCode}`}</span>
        ) : null}
      </span>
      <span className="trace-row-end">
        {status ? (
          <span className="trace-row-status" data-status={row.statusCode} title={row.status}>
            <Icon name={status} size={16} />
            <span className="trace-visually-hidden">{row.status}</span>
          </span>
        ) : null}
        {timed ? <span className="trace-row-duration">{durationLabel(row.durationMs)}</span> : null}
      </span>
    </Button>
  )
}
