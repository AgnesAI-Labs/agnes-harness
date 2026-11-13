import { redactSecrets } from '@agnes/extension-api'

/** Mask with full context, but retain only characters from the original excerpt window. */
export function redactedWindow(text: string, limit: number, edge: 'first' | 'last'): string {
  const start = edge === 'first' ? 0 : Math.max(0, text.length - limit)
  const end = edge === 'first' ? Math.min(text.length, limit) : text.length
  const redacted = redactSecrets(text)
  if (redacted === text) return text.slice(start, end)

  // The public sanitizer returns text, not source offsets. Conservatively mask the whole span
  // between its first and last change, including any intervening ordinary text. Never slice the
  // shortened result: that could pull undisclosed characters from outside the original window.
  let left = 0
  while (left < text.length && left < redacted.length && text[left] === redacted[left]) left++
  let right = text.length
  let redactedRight = redacted.length
  while (right > left && redactedRight > left && text[right - 1] === redacted[redactedRight - 1]) {
    right--
    redactedRight--
  }
  const from = Math.max(start, left)
  const to = Math.min(end, right)
  if (from >= to) return text.slice(start, end)
  // Even a one-character credential at a boundary must not expand the bounded payload.
  const mask = '[REDACTED]'.slice(0, to - from)
  return text.slice(start, from) + mask + text.slice(to, end)
}
