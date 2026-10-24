import { type DiagnosticRecord, errorMessageKey } from '@agnes/protocol'
import {
  appServerErrorMessage,
  Banner,
  Button,
  EmptyState,
  Icon,
  Segmented,
  SettingsBlock,
  SettingsDrill,
  SettingsGroup,
  SettingsItem,
  SettingsTag,
  StatusMessage,
  useSettingsSubpages,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { type ErrorKind, errorKind } from './diagnostics-kinds.js'
import { DIAGNOSTICS_NAMESPACE, diagnosticsCatalog } from './diagnostics-locale.js'

/** How many kinds the list shows before 「查看全部」. */
const RECENT = 5
/** How many of a kind's latest occurrences its details list. */
const OCCURRENCES = 3
type Filter = 'all' | ErrorKind

export type ErrorGroup = {
  kind: ErrorKind
  latest: DiagnosticRecord
  first: DiagnosticRecord
  count: number
  /** Newest first, at most `OCCURRENCES`. */
  recent: DiagnosticRecord[]
}
const kindKey = (record: DiagnosticRecord) => `${record.name}\u0000${record.cause ?? ''}\u0000${record.code}`

/**
 * The page id of a kind of error: its key as base64url, so it is stable across reads, differs
 * between kinds and fits the address bar (`?settings=diagnostics/errors/<id>`).
 */
export function errorDrillId(record: DiagnosticRecord): string {
  const bytes = String.fromCharCode(...new TextEncoder().encode(kindKey(record)))
  return `err-${btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

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

/** What the page's entry row says: kinds seen on the latest day when that is today, else all kinds. */
export function errorsEntry(records: readonly DiagnosticRecord[]) {
  const groups = groupErrors(records)
  const [first] = byDay(groups)
  return {
    kinds: groups.length,
    today:
      first?.key === new Date().toDateString()
        ? { kinds: first.groups.length, count: first.count }
        : undefined,
  }
}

/**
 * 近期错误: a summary, kind filters, then one row per kind grouped by day, each opening
 * its own page for its IDs. An ID lookup shows only that kind; empty, not-found and failed reads each
 * say what happened.
 */
export function RecentErrors({
  records,
  lookup,
  limit,
  failure,
  notice,
  onRetryCopy,
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
  /** A failure from the page's last action, shown beside the details that raised it. */
  notice?: string | undefined
  onRetryCopy(): void
  onRetry(): void
  onClear(): void
  copy(value: string, done: string): void
}) {
  const { t } = useUiText(DIAGNOSTICS_NAMESPACE, diagnosticsCatalog)
  const [filter, setFilter] = useState<Filter>('all')
  const [all, setAll] = useState(false)
  const { stack, back } = useSettingsSubpages()
  const groups = groupErrors(lookup?.records ?? records)
  const open = stack.at(-1)?.startsWith('err-') ? stack.at(-1) : undefined
  const gone =
    open !== undefined && (failure !== undefined || !groups.some((g) => errorDrillId(g.latest) === open))
  // An error page whose kind is no longer listed (a stale address, a failed read) returns to the list.
  useEffect(() => {
    if (gone) back()
  }, [gone, back])
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
  /** `id` names a looked-up record, which need not be its kind's latest. */
  const row = (group: ErrorGroup, id = group.latest.diagnosticId) => {
    const record = group.latest
    return (
      <SettingsDrill
        key={kindKey(record)}
        id={errorDrillId(record)}
        data-testid="diagnostics-error"
        data-kind={group.kind}
        className="agnes-diagnostics-error"
        leading={
          <span className="agnes-diagnostics-kind-cell">
            <span className="agnes-diagnostics-severity" aria-hidden="true" />
            <SettingsTag tone="muted" data-kind={group.kind} className="agnes-diagnostics-kind">
              {t(`filter.${group.kind}`)}
            </SettingsTag>
          </span>
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
        <p className="agnes-diagnostics-when" data-testid="diagnostics-error-summary">
          <SettingsTag tone="muted" data-kind={group.kind} className="agnes-diagnostics-kind">
            {t(`filter.${group.kind}`)}
          </SettingsTag>
          <span>
            {t(group.count === 1 ? 'occurrences.one' : 'occurrences', { count: number(group.count) })}
          </span>
        </p>
        <SettingsBlock className="agnes-diagnostics-details" data-testid="diagnostics-error-details">
          {notice === 'copyFailed' && (
            <StatusMessage
              kind="error"
              data-testid="diagnostics-notice"
              action={{ label: t('retry'), onSelect: onRetryCopy }}
            >
              {t(notice)}
            </StatusMessage>
          )}
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
      </SettingsDrill>
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
          description=""
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
        <SettingsGroup>{row(listed ?? groups[0], found.diagnosticId)}</SettingsGroup>
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
  // The kind whose page is open stays mounted past the filter and the first few, so its page can render.
  const filtered = groups.filter(
    (group) => filter === 'all' || group.kind === filter || errorDrillId(group.latest) === open,
  )
  const shown = all
    ? filtered
    : filtered.filter((group, i) => i < RECENT || errorDrillId(group.latest) === open)
  return (
    <>
      <p className="agnes-settings-note agnes-diagnostics-summary" data-testid="diagnostics-summary">
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
        {!shown.length && (
          <EmptyState
            className="agnes-diagnostics-state"
            data-testid="diagnostics-filter-empty"
            icon={<Icon name="search" />}
            title={t('empty')}
            description={t('emptyHelp')}
          />
        )}
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
