import type { Event } from '@agnes/core-common/types'

/**
 * Lossy presentation rows carry no execution authority and must never be re-hashed or exported.
 * A row that materializes a register is state, not presentation: its payload is folded back into
 * ledger state (and decision/state is digest-checked), so it is returned byte for byte. Truncating
 * inside it would change the value the projection reads, not just how it is shown.
 */
export function leanEvents(events: readonly Event[]): Event[] {
  const lean = (value: unknown, depth = 0): unknown => {
    if (depth > 32) return '[Preview depth limit]'
    if (Array.isArray(value)) return value.map((child) => lean(child, depth + 1))
    if (!value || typeof value !== 'object') return value
    const block = value as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 16384)
      return { ...block, text: `${block.text.slice(0, 16384)}[Unverified preview truncated]` }
    if (
      ['image', 'audio', 'file', 'base64'].includes(String(block.type)) &&
      (typeof block.data === 'string' || typeof block.base64 === 'string')
    )
      return { type: 'text', text: '[Original media omitted from unverified preview]' }
    return Object.fromEntries(Object.entries(block).map(([key, child]) => [key, lean(child, depth + 1)]))
  }
  return events.map((event) =>
    event.register === undefined ? { ...event, data: lean(event.data) as Event['data'] } : event,
  )
}
