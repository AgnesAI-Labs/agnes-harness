import { redactSecrets } from '@agnes/extension-api'

/** Mask full available context once, then clip in original UTF-16 source coordinates. */
export function redactedRanges(
  text: string,
  redacted = redactSecrets(text),
): (start: number, end: number) => string {
  let left = 0
  let right = text.length
  if (redacted !== text) {
    while (left < text.length && left < redacted.length && text[left] === redacted[left]) left++
    let redactedRight = redacted.length
    while (right > left && redactedRight > left && text[right - 1] === redacted[redactedRight - 1]) {
      right--
      redactedRight--
    }
  } else left = right
  return (start, end) => {
    const from = Math.max(start, left)
    const to = Math.min(end, right)
    if (from >= to) return text.slice(start, end)
    // Conservatively mask the whole changed span. Shortening must never expose outside bytes.
    return text.slice(start, from) + '[REDACTED]'.slice(0, to - from) + text.slice(to, end)
  }
}
