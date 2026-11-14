/** Localization, reason formatting, message marker cleanup, and relative timestamp helpers. */
import type { SuperagentKey } from './locales.js'
import { type Health, type Localized, type Reason, reasonText, type SetupProblem } from './shared.js'

/** The translator of the active language: a dictionary key and the values of its `{name}` placeholders. */
export type T = (key: SuperagentKey, params?: Record<string, string | number>) => string
export const errorText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure)
export const localized = (t: T, text: Localized | string | undefined): string =>
  typeof text === 'string' ? text : text ? text[t('lang') === 'en' ? 'en' : 'zh'] : ''
export const actorName = (t: T, actor: { name?: Localized } | undefined): string =>
  actor?.name ? localized(t, actor.name) : t('automatedNotice')
export function valueLabel(t: T, group: string, key: string | undefined): string {
  if (!key) return ''
  const name = `${group}.${key}` as SuperagentKey
  const text = t(name)
  return text === name ? key : text
}
/** Format one or more structured or raw reasons in the active UI language, truncating multi-line host errors to their first line. */
export function reasonLabel(t: T, reason: string | Reason | readonly Reason[] | undefined): string {
  if (typeof reason === 'string') return reason ? label(t, { code: reason }) : ''
  return [reason ?? []]
    .flat()
    .map((item) => label(t, item))
    .filter(Boolean)
    .join('；')
}
function label(t: T, reason: Reason): string {
  const key = `reason.${reason.code}` as SuperagentKey
  const text = reason.code === 'said' ? (reason.values?.text ?? '') : t(key, reason.values)
  if (reason.code !== 'said' && text !== key) return text
  const written =
    reason.code === 'said'
      ? text
      : reasonText({ code: reason.code, ...(reason.values ? { values: reason.values } : {}) })
  if (/^\w*Error\b/.test(written)) {
    const first = written.split('\n')[0]!
    return first.length > 140 ? `${first.slice(0, 140)}…` : first
  }
  return written
}
export const setupText = (t: T, problem: Pick<SetupProblem, 'code' | 'values'>): string =>
  t(`setup.${problem.code}`, problem.values)
export const healthText = (t: T, health: Pick<Health, 'detail' | 'code' | 'values'>): string =>
  health.code ? t(`healthCode.${health.code}` as const, health.values) : health.detail
/** Replaces Feishu and GitHub content placeholders (images, cards, media, forwards, unresolved mentions) with localized labels. */
export function readableMarkers(t: T, text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]|\[image\]/g, t('imageMarker'))
    .replace(/\[Chat card: [^\]]*\]/g, t('cardMarker'))
    .replace(/\[Media: [^\]]*\]/g, t('mediaMarker'))
    .replace(/\[Merged forward\]/g, t('forwardMarker'))
    .replace(/@_user_\d+/g, t('unknownMention'))
}
const timeLocale = (lang: string) => (lang === 'en' ? 'en' : 'zh-CN')
export function when(value: string | undefined, lang: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  if (Math.abs(seconds) < 86_400) {
    const relative = new Intl.RelativeTimeFormat(timeLocale(lang), { numeric: 'auto' })
    if (Math.abs(seconds) < 60) return relative.format(0, 'second')
    if (Math.abs(seconds) < 3600) return relative.format(Math.round(seconds / 60), 'minute')
    return relative.format(Math.round(seconds / 3600), 'hour')
  }
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const year = sameYear ? {} : ({ year: 'numeric' } as const)
  return date.toLocaleString(timeLocale(lang), {
    ...year,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
export function fullTime(value: string | undefined, lang: string): string {
  const date = new Date(value ?? '')
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(timeLocale(lang))
}
/** The translator of one language: its dictionary, with `{name}` placeholders filled from the call's values. */
export function translator(dictionary: Readonly<Record<string, string>>): T {
  return ((key: string, params?: Record<string, string | number>) => {
    const template = dictionary[key] ?? key
    return params
      ? template.replace(/\{(\w+)\}/g, (match, name: string) =>
          name in params ? String(params[name]) : match,
        )
      : template
  }) as T
}
