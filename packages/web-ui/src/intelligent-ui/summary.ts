import type { JsonValue, UiSurface } from '@agnes/protocol/gen/intelligent-ui'
import { useEffect, useState } from 'react'
import type { IconName } from '../ui/icon-set.js'
import type { LocaleTranslator } from '../ui-locale.js'
import { questionForm } from './question.js'

type TitledSurface = Pick<UiSurface, 'title' | 'titleKey'>

/** A known `titleKey` wins; an unknown one falls back to the literal title the author sent. */
export function surfaceTitle(surface: TitledSurface, t: LocaleTranslator): string {
  if (!surface.titleKey) return surface.title
  const translated = t(surface.titleKey)
  return translated === surface.titleKey ? surface.title : translated
}

/** A surface that only hands over files: a file list, shown with the turn that produced it. */
export function isDeliverableList(surface: Pick<UiSurface, 'components'>): boolean {
  return (
    surface.components.length > 0 &&
    surface.components.every((component) => component.kind === 'artifact-file')
  )
}

/** Only words and nothing to act on: when it may show inline, it is read in the answer. */
export function isTextOnly(surface: Pick<UiSurface, 'components' | 'actions'>): boolean {
  return (
    surface.components.length > 0 &&
    surface.components.every((component) => component.kind === 'text') &&
    !surface.actions.length
  )
}

/**
 * A card inside the answer that produced it, between its text and its action row: a surface that may
 * show inline and does not prefer the workbench, or one that is only text and may show inline. A
 * workbench-only surface never enters the answer, text or not. Files and questions have their own
 * places.
 */
export function rendersInAnswer(
  surface: Pick<UiSurface, 'placement' | 'components' | 'actions' | 'data'>,
): boolean {
  if (isDeliverableList(surface) || questionForm(surface)) return false
  return surface.placement.inline && (isTextOnly(surface) || surface.placement.preferred !== 'workbench')
}

/** A surface whose complete view lives in the workbench is docked in the conversation as a one-line chip. */
export function docksInConversation(
  surface: Pick<UiSurface, 'placement' | 'components' | 'actions' | 'data'>,
): boolean {
  return (
    surface.placement.workbench &&
    !rendersInAnswer(surface) &&
    (!surface.placement.inline || !isDeliverableList(surface))
  )
}

/** Authors send plain labels. The common ones are shared vocabulary and follow the locale. */
export function columnLabel(label: string, t: LocaleTranslator): string {
  const word = label.trim().toLowerCase()
  if (!/^[a-z]{1,24}$/.test(word)) return label
  const key = `ui.column.${word}`
  const translated = t(key)
  return translated === key ? label : translated
}

/** Lifecycle states shared by many extensions. Unknown business states keep their literal label. */
export function stateLabel(value: string, t: LocaleTranslator): string {
  const word = value.trim().toLowerCase()
  if (!/^[a-z]{1,24}$/.test(word)) return value
  const key = `ui.state.${word}`
  const translated = t(key)
  return translated === key ? value : translated
}

export interface UiInstant {
  iso: string
  /** Local clock time, with the date once it is not today. */
  time: string
  relative: string
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
const UNITS = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
] as const

/** Only a full timestamp with an offset is an instant; a bare date stays a calendar date. */
export function uiInstant(value: JsonValue | undefined, locale: string, now: number): UiInstant | undefined {
  if (typeof value !== 'string' || !INSTANT.test(value)) return undefined
  const at = Date.parse(value)
  if (Number.isNaN(at)) return undefined
  const date = new Date(at)
  const sameDay = date.toDateString() === new Date(now).toDateString()
  const time = new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
  const delta = at - now
  const [unit, size] = UNITS.find(([, size]) => Math.abs(delta) >= size) ?? UNITS[2]
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
    Math.round(delta / size),
    unit,
  )
  return { iso: value, time, relative }
}

type UiTable = Extract<UiSurface['components'][number], { kind: 'table'; columns: unknown }>
/** A custom component may claim any kind; only the preset table carries columns. */
const isTable = (component: UiSurface['components'][number]): component is UiTable =>
  component.kind === 'table' && !('fallback' in component)
const uiRecord = (value: unknown): value is Record<string, JsonValue> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function surfaceIcon(surface: Pick<UiSurface, 'components'>): IconName {
  const kinds = new Set(surface.components.map((component) => component.kind))
  if (kinds.has('artifact-file')) return 'file-text'
  if (
    surface.components.some(
      (component) => isTable(component) && component.columns.some((column) => column.format === 'date'),
    )
  )
    return 'clock'
  if (kinds.has('chart')) return 'activity'
  if (kinds.has('form')) return 'list'
  return 'panel-right'
}

/**
 * One useful line for the docked chip. The author's summary wins; otherwise it is read from the
 * data the surface already carries. Returns nothing rather than a filler sentence.
 */
export function surfaceDockSummary(
  surface: UiSurface,
  options: { t: LocaleTranslator; locale: string; now: number; actionable: boolean },
): string | undefined {
  const { t } = options
  if (surface.summary?.trim()) return surface.summary.trim()
  const text = surface.components.find((component) => component.kind === 'text')
  const body = text && 'dataKey' in text ? surface.data[text.dataKey] : undefined
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 240)
  for (const component of surface.components) {
    if (!isTable(component)) continue
    const data = surface.data[component.dataKey]
    const rows = Array.isArray(data) ? data.filter(uiRecord) : []
    if (!rows.length) continue
    const parts: string[] = []
    const dated = component.columns.find((column) => column.format === 'date')
    if (dated) {
      // The soonest upcoming instant is the one worth a glance; past ones only when nothing is ahead.
      const instants = rows
        .map((row) => uiInstant(row[dated.key], options.locale, options.now))
        .filter((instant): instant is UiInstant => !!instant)
        .sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso))
      const next = instants.find((instant) => Date.parse(instant.iso) >= options.now) ?? instants.at(-1)
      if (next)
        parts.push(
          t('ui.dock.instant', {
            label: columnLabel(dated.label, t),
            time: next.time,
            relative: next.relative,
          }),
        )
    }
    const first = rows[0]?.[component.columns[0]?.key ?? '']
    if (rows.length === 1 && typeof first === 'string' && first.trim()) parts.push(first.trim().slice(0, 80))
    else parts.push(t('ui.dock.rows', { count: rows.length }))
    return parts.join(' · ')
  }
  return options.actionable && surface.actions.length
    ? t('ui.summary', { count: surface.actions.length })
    : undefined
}

/** Relative times ("in 3 minutes") drift; one shared tick keeps them honest without a per-second render. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
