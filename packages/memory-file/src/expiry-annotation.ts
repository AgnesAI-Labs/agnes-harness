import type { NextExpiryProvider, ViewFilter } from './pipeline.js'
import type { HideRange } from './view.js'

const annotation = /^<!--\s*expires_at:/u
const iso = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/u

function expiryTime(value: string): number {
  const match = iso.exec(value)
  if (!match) return NaN
  const [, date, time, zone] = match
  // Date.parse normalizes February 30 and other impossible dates. Reject those too.
  const midnight = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(midnight.getTime()) || !midnight.toISOString().startsWith(`${date}T`)) return NaN
  return time ? Date.parse(`${date}T${time}${zone ?? 'Z'}`) : midnight.getTime()
}

function* annotations(content: string) {
  let pending: { start: number; expiresAt: number }[] = []
  for (const line of content.matchAll(/[^\n]*\n|[^\n]+$/gu)) {
    const text = line[0].trim()
    if (!text) {
      for (const item of pending) yield { ...item, end: line.index }
      pending = []
      continue
    }
    const match = annotation.exec(text)
    if (match && text.indexOf('-->') === text.length - 3) {
      pending.push({ start: line.index, expiresAt: expiryTime(text.slice(match[0].length, -3).trim()) })
    }
  }
  for (const item of pending) yield { ...item, end: content.length }
}

export const expiryViewFilter: ViewFilter = (entry, ctx) => {
  if (ctx.layer !== 'workspace') return []
  const ranges: HideRange[] = []
  for (const { start, end, expiresAt } of annotations(entry.content)) {
    if (expiresAt > ctx.now) continue
    const invalid = !Number.isFinite(expiresAt)
    ranges.push({
      start,
      end,
      appliesTo: 'both',
      reason: invalid ? 'expiry-invalid' : 'expiry-annotation',
      notice: invalid
        ? '[1 paragraph with unparseable expiry date hidden]'
        : '[1 paragraph past its expiry date hidden]',
    })
  }
  return ranges
}

export const expiryNextExpiry: NextExpiryProvider = (files, ctx) => {
  let earliest: number | undefined
  for (const entry of files) {
    for (const { expiresAt } of annotations(entry.content)) {
      if (expiresAt > ctx.now && (earliest === undefined || expiresAt < earliest)) earliest = expiresAt
    }
  }
  return earliest
}
