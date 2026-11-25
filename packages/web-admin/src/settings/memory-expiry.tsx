import { useUiText } from '@agnes/web-ui'
import { useEffect, useReducer } from 'react'
import { memoryCatalog } from './memory-locale.js'

// Keep the editor preview in step with memory-file/src/expiry-annotation.ts.
const annotation = /^<!--\s*expires_at:/u
const iso = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/u

function expiryTime(value: string): number {
  const match = iso.exec(value)
  if (!match) return NaN
  const [, date, time, zone] = match
  const midnight = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(midnight.getTime()) || !midnight.toISOString().startsWith(`${date}T`)) return NaN
  return time ? Date.parse(`${date}T${time}${zone ?? 'Z'}`) : midnight.getTime()
}

export function analyzeExpiry(content: string, now: number) {
  let expired = 0
  let invalid = 0
  let future = 0
  let earliest: number | undefined
  // Each standalone marker covers the text from its line to the next blank line or EOF.
  // Counting the markers directly also handles multiple markers before the same blank line.
  for (const line of content.split('\n')) {
    const text = line.trim()
    const marker = annotation.exec(text)
    if (!marker || text.indexOf('-->') !== text.length - 3) continue
    const time = expiryTime(text.slice(marker[0].length, -3).trim())
    if (!Number.isFinite(time)) invalid++
    else if (time <= now) expired++
    else {
      future++
      earliest = Math.min(earliest ?? time, time)
    }
  }
  return { expired, invalid, future, earliest }
}

export function useDeadlineTick(earliest: number | undefined) {
  const [tick, refresh] = useReducer((tick: number) => tick + 1, 0)
  useEffect(() => {
    if (earliest === undefined) return
    let timer: ReturnType<typeof setTimeout>
    const wake = () => {
      const remaining = earliest - Date.now()
      if (remaining <= 0) refresh()
      else timer = setTimeout(wake, Math.min(remaining, 2_147_483_647))
    }
    wake()
    return () => clearTimeout(timer)
  }, [earliest])
  return tick
}

export function MemoryExpiryStatus({ content, memoryOff }: { content: string; memoryOff: boolean }) {
  const { locale, t } = useUiText('@agnes/web/memory', memoryCatalog)
  const { expired, invalid, future, earliest } = analyzeExpiry(content, Date.now())
  useDeadlineTick(earliest)

  if (!expired && !invalid && !future) return null
  return (
    <p className="agnes-settings-note" role="status" data-testid="memory-expiry-status">
      {[
        expired > 0 && t('expiry.expired', { count: expired }),
        invalid > 0 && t('expiry.invalid', { count: invalid }),
        (expired > 0 || invalid > 0) && t('expiry.restore'),
        earliest !== undefined &&
          t('expiry.future', {
            count: future,
            date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
              earliest,
            ),
          }),
        memoryOff && t('expiry.off'),
      ]
        .filter(Boolean)
        .join(' ')}
    </p>
  )
}
