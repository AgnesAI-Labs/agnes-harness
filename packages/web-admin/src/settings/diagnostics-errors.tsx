import { type DiagnosticRecord, errorMessageKey } from '@agnes/protocol'
import {
  appServerErrorMessage,
  Banner,
  Button,
  EmptyState,
  Icon,
  Segmented,
  SettingsBlock,
  SettingsExpand,
  SettingsGroup,
  SettingsItem,
  SettingsTag,
  type SettingsTagTone,
  useUiText,
} from '@agnes/web-ui'
import { useState } from 'react'
import { type ErrorKind, errorKind } from './diagnostics-kinds.js'
import { DIAGNOSTICS_NAMESPACE, diagnosticsCatalog } from './diagnostics-locale.js'

/** How many kinds the list shows before 「查看全部」. */
const RECENT = 5
/** How many of a kind's latest occurrences its details list. */
const OCCURRENCES = 3
type Filter = 'all' | ErrorKind
const TONES: Record<ErrorKind, SettingsTagTone> = {
  permission: 'brand',
  provider: 'warn',
  plugin: 'muted',
  other: 'muted',
}

export type ErrorGroup = {
  kind: ErrorKind
  latest: DiagnosticRecord
  first: DiagnosticRecord
  count: number
  /** Newest first, at most `OCCURRENCES`. */
  recent: DiagnosticRecord[]
}
const kindKey = (record: DiagnosticRecord) => `${record.name}\u0000${record.cause ?? ''}\u0000${record.code}`

/** One row per kind of error (same name, cause and code), newest first, counting its repeats. */
export function groupErrors(records: readonly DiagnosticRecord[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>()
  // The journal is oldest first; the stable sort keeps that order between equal times.
  for (const record of [...records].reverse().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const known = groups.get(kindKey(record))
    if (!known)
      groups.set(kindKey(record), {
        kind: errorKind(record),
        latest: record,
        first: record,
        count: 1,
        recent: [record],
      })
    else {
      known.count += 1
      known.first = record
      if (known.recent.length < OCCURRENCES) known.recent.push(record)
    }
  }
  return [...groups.values()]
}

/** Kinds under the local day of their latest occurrence; `groups` is already newest first. */
function byDay(groups: readonly ErrorGroup[]) {
  const days: { key: string; at: string; groups: ErrorGroup[]; count: number }[] = []
  for (const group of groups) {
    const key = new Date(group.latest.at).toDateString()
    let day = days.at(-1)
    if (day?.key !== key) {
      day = { key, at: group.latest.at, groups: [], count: 0 }
      days.push(day)
    }
    day.groups.push(group)
    day.count += group.count
  }
  return days
}

/**
 * 近期错误: a summary, kind filters, then one row per kind grouped by day, each opening in
 * place for its IDs. An ID lookup shows only that kind; empty, not-found and failed reads each
 * say what happened.
 */
export function RecentErrors({
  records,
  lookup,
  limit,
  failure,
  onRetry,
  onClear,
  copy,
}: {
  records: readonly DiagnosticRecord[]
  /** What an ID lookup returned; absent while listing everything. */
  lookup?: { id: string; records: readonly DiagnosticRecord[] } | undefined
  /** How many records the daemon retains (`limits.errors`). */
  limit: number
  /** Set when the read failed: what to tell the user. */
  failure?: string | undefined
  onRetry(): void
  onClear(): void
  copy(value: string, done: string): void
}) {
  const { t } = useUiText(DIAGNOSTICS_NAMESPACE, diagnosticsCatalog)
  const [filter, setFilter] = useState<Filter>('all')
  const [all, setAll] = useState(false)
  const locale = document.documentElement.lang || 'en'
  const number = (value: number) => new Intl.NumberFormat(locale).format(value)
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86_400_000).toDateString()
  const clock = (at: string) => {
    const date = new Date(at)
    const time = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date)
    if (date.toDateString() === today) return time
    if (date.toDateString() === yesterday) return t('yesterdayAt', { time })
    return `${new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(date)} ${time}`
  }
  const message = (record: DiagnosticRecord) => {
    const key = errorMessageKey(record.cause ?? record.name)
    return (
      appServerErrorMessage(
        { data: { messageKey: key === 'appServer.errors.internal' ? errorMessageKey(record.name) : key } },
        locale,
      ) ?? t('unavailable')
    )
  }
  if (failure !== undefined)
    return (
      <EmptyState
        className="agnes-diagnostics-state"
        data-tone="error"
        data-testid="diagnostics-failure"
        icon={<Icon name="circle-alert" />}
        title={t('readFailed')}
        description={failure}
        actions={
          <Button size="small" onClick={onRetry}>
            {t('retry')}
          </Button>
        }
      />
    )
  const groups = groupErrors(lookup?.records ?? records)
  /** `id` names a looked-up record, which need not be its kind's latest. */
  const row = (group: ErrorGroup, open = false, id = group.latest.diagnosticId) => {
    const record = group.latest
    return (
      <SettingsExpand
        key={kindKey(record)}
        data-testid="diagnostics-error"
        data-kind={group.kind}
        className="agnes-diagnostics-error"
        defaultOpen={open}
        leading={
          <SettingsTag tone={TONES[group.kind]} data-kind={group.kind} className="agnes-diagnostics-kind">
            {t(`filter.${group.kind}`)}
          </SettingsTag>
        }
        label={message(record)}
        hint={
          <span className="agnes-diagnostics-when">
            <span>
              {t('last')}{' '}
              <time dateTime={record.at} data-testid="diagnostics-error-time">
                {clock(record.at)}
              </time>
            </span>
            {group.count > 1 && <span>{`${t('first')} ${clock(group.first.at)}`}</span>}
            <code>{record.name}</code>
          </span>
        }
        value={t(group.count === 1 ? 'occurrences.one' : 'occurrences', { count: number(group.count) })}
      >
        <SettingsBlock className="agnes-diagnostics-details">
          <SettingsItem label={t('id')}>
            <span className="agnes-diagnostics-id">
              <code data-testid="diagnostics-error-id">{id}</code>
              <Button
                size="small"
                aria-label={t('copy')}
                data-testid="diagnostics-copy"
                onClick={() => copy(id, 'copied')}
              >
                {t('copyShort')}
              </Button>
            </span>
          </SettingsItem>
          <SettingsItem label={t('name')}>
            <code>{record.name}</code>
          </SettingsItem>
          <SettingsItem label={t('code')}>
            <code data-testid="diagnostics-error-code">{record.code}</code>
          </SettingsItem>
          {record.cause && (
            <SettingsItem label={t('cause')}>
              <code>{record.cause}</code>
            </SettingsItem>
          )}
          {group.count > 1 && (
            <>
              <SettingsItem label={t('seen')}>
                <span className="agnes-settings-value">
                  {t('range', {
                    count: number(group.count),
                    from: clock(group.first.at),
                    to: clock(record.at),
                  })}
                </span>
              </SettingsItem>
              <SettingsItem label={t('recentTimes')}>
                <ul className="agnes-diagnostics-occurrences">
                  {group.recent.map((item) => (
                    <li key={item.diagnosticId}>
                      <time dateTime={item.at}>{clock(item.at)}</time>
                      <code>{`${item.diagnosticId.slice(0, 8)}…${item.diagnosticId.slice(-4)}`}</code>
                      <Button
                        size="small"
                        aria-label={t('copyOccurrence', { time: clock(item.at) })}
                        data-testid="diagnostics-copy-occurrence"
                        onClick={() => copy(item.diagnosticId, 'copied')}
                      >
                        {t('copyShort')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </SettingsItem>
            </>
          )}
        </SettingsBlock>
      </SettingsExpand>
    )
  }
  if (lookup) {
    if (!groups[0])
      return (
        <EmptyState
          className="agnes-diagnostics-state"
          data-testid="diagnostics-not-found"
          icon={<Icon name="search" />}
          title={t('notFound')}
          description={t('notFoundHelp', { count: number(limit) })}
          actions={
            <Button size="small" onClick={onClear}>
              {t('clearLookup')}
            </Button>
          }
        />
      )
    // The kind as the list counts it, if the list has it; the details still name the found ID.
    const found = groups[0].latest
    const listed = groupErrors(records).find((group) => kindKey(group.latest) === kindKey(found))
    return (
      <>
        <Banner
          data-testid="diagnostics-found"
          action={
            <Button type="text" size="small" onClick={onClear}>
              {t('clearToAll')}
            </Button>
          }
        >
          {t('found')}
        </Banner>
        <SettingsGroup>{row(listed ?? groups[0], true, found.diagnosticId)}</SettingsGroup>
      </>
    )
  }
  if (!groups.length)
    return (
      <EmptyState
        className="agnes-diagnostics-state"
        data-tone="ok"
        data-testid="diagnostics-empty"
        icon={<Icon name="check" />}
        title={t('noErrors')}
        description={t('noErrorsHelp')}
      />
    )
  const counts = (kind: Filter) =>
    number(kind === 'all' ? groups.length : groups.filter((group) => group.kind === kind).length)
  const filtered = filter === 'all' ? groups : groups.filter((group) => group.kind === filter)
  const shown = all ? filtered : filtered.slice(0, RECENT)
  return (
    <>
      <p className="agnes-settings-note" data-testid="diagnostics-summary">
        {t('summary', { records: number(records.length), kinds: number(groups.length) })}
      </p>
      <Segmented<Filter>
        label={t('filterKind')}
        testId="diagnostics-filter-kind"
        value={filter}
        options={(['all', 'permission', 'provider', 'plugin', 'other'] as const).map((value) => ({
          value,
          label: (
            <>
              {t(`filter.${value}`)}
              <span className="agnes-diagnostics-filter-count">{counts(value)}</span>
            </>
          ),
        }))}
        onChange={setFilter}
      />
      <SettingsGroup data-testid="diagnostics-list">
        {!shown.length && <SettingsItem label={t('empty')} />}
        {byDay(shown).map((day) => {
          const label = day.key === today ? t('today') : day.key === yesterday ? t('yesterday') : undefined
          const date = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(
            new Date(day.at),
          )
          const totals = t('dayCounts', { kinds: number(day.groups.length), count: number(day.count) })
          return [
            <h4 key={day.key} className="agnes-diagnostics-day" data-testid="diagnostics-day">
              <strong>{label ?? date}</strong>
              <span>{label ? `${date} · ${totals}` : totals}</span>
            </h4>,
            ...day.groups.map((group) => row(group)),
          ]
        })}
        <div className="agnes-diagnostics-footer">
          <span data-testid="diagnostics-retained">{t('retained', { count: number(limit) })}</span>
          {filtered.length > RECENT && (
            <Button type="text" size="small" data-testid="diagnostics-view-all" onClick={() => setAll(!all)}>
              {all ? t('showLess') : t('viewAllKinds', { count: number(filtered.length) })}
              {!all && <Icon name="chevron-right" />}
            </Button>
          )}
        </div>
      </SettingsGroup>
    </>
  )
}
