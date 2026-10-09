/**
 * t() and formatting (mhs-ui-design section 4.3). English is the source; a missing translation shows
 * the English text, never the key. Units are not translated.
 */
import { en, type Key } from './en.js'
import { zhCN } from './zh-CN.js'

export type Locale = 'en' | 'zh-CN'
export type { Key }

export const catalogs: Record<Locale, Partial<Record<Key, string>>> = { en, 'zh-CN': zhCN }

let current: Locale = 'en'
const listeners = new Set<() => void>()

export function setLocale(locale: string): void {
  const next: Locale = locale === 'zh-CN' ? 'zh-CN' : 'en'
  if (next === current) return
  current = next
  for (const listener of [...listeners]) listener()
}

export function getLocale(): Locale {
  return current
}

export function onLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function t(key: Key, vars?: Record<string, string | number>): string {
  const template = catalogs[current][key] ?? en[key]
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

/** Looks up a word from a fixed vocabulary (reasons, roles, kinds…); unknown codes come back as given. */
export function word(prefix: string, code: string, fallback?: string): string {
  const key = `${prefix}.${code}` as Key
  return key in en ? t(key) : (fallback ?? code)
}

const numberFormats = new Map<string, Intl.NumberFormat>()

/** A number with at most `digits` decimals, in the current language. */
export function num(value: number, digits = 1): string {
  const id = `${current}/${digits}`
  let f = numberFormats.get(id)
  if (!f) {
    f = new Intl.NumberFormat(current, { maximumFractionDigits: digits })
    numberFormats.set(id, f)
  }
  return f.format(value)
}

/** A value with its declared unit: "64 %", "12.5 °C", "on". */
export function valueText(value: unknown, unit?: string): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') {
    // A field in seconds holding a Unix time (MHS 3: times are Unix seconds) reads as a clock time.
    if (unit === 's' && value > 1e9) return timeText(value)
    const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2
    const n = num(value, digits)
    return unit ? `${n} ${unit === 'deg' ? '°' : unit}` : n
  }
  if (typeof value === 'boolean') return value ? '✓' : '✗'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/** "23:50:20 · in 2 min" or "23:46:10 · 3 min ago" for a Unix time in seconds. */
export function timeText(unixSeconds: number): string {
  const clock = new Intl.DateTimeFormat(current, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const delta = unixSeconds - Date.now() / 1000
  const f = new Intl.RelativeTimeFormat(current, { numeric: 'auto', style: 'short' })
  const rel =
    Math.abs(delta) < 60
      ? f.format(Math.round(delta), 'second')
      : Math.abs(delta) < 3600
        ? f.format(Math.round(delta / 60), 'minute')
        : f.format(Math.round(delta / 3600), 'hour')
  return `${clock.format(new Date(unixSeconds * 1000))} · ${rel}`
}

/** "0.4 s ago", "3 min ago", in the current language. */
export function ago(seconds: number): string {
  if (seconds < 1) return t('time.now')
  const f = new Intl.RelativeTimeFormat(current, { numeric: 'always', style: 'short' })
  if (seconds < 60) return f.format(-Math.round(seconds), 'second')
  if (seconds < 3600) return f.format(-Math.round(seconds / 60), 'minute')
  return f.format(-Math.round(seconds / 3600), 'hour')
}

/** A duration: "12 s", "3 min 5 s". */
export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
}
