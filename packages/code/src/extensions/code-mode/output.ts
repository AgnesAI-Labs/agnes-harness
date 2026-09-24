export type GuardedOutput = { text: string; truncated: boolean; full?: string }

/** Counts UTF-16 code units, as max_output_chars does. Never cuts a surrogate pair. */
export function guardOutput(text: string, maxChars: number): GuardedOutput {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1024)
    throw new Error('E_PRESET_UNSUPPORTED: invalid output limit')
  if (text.length <= maxChars) return { text, truncated: false }
  const cap = Math.min(maxChars, 65536)
  let marker = ''
  let head = '',
    tail = ''
  for (;;) {
    const room = cap - marker.length
    const headChars = Math.floor((room * 3) / 4)
    head = text.slice(0, headChars)
    tail = text.slice(-(room - headChars))
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
    if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1)
    const next = `\n... [${text.length - head.length - tail.length} chars elided] ...\n`
    if (next === marker) break
    marker = next
  }
  return { text: head + marker + tail, truncated: true, full: text }
}
