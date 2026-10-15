/** A jobs.read response is a raw, bounded text tail, not a rendered screen or a stream. */
export function snapshotDelta(previous: string, next: string): { reset: boolean; text: string } {
  if (next.startsWith(previous)) return { reset: false, text: next.slice(previous.length) }
  // KMP finds the longest old suffix/new prefix in linear time even for repetitive output.
  const prefix = new Uint32Array(next.length)
  for (let i = 1, matched = 0; i < next.length; i++) {
    while (matched && next[i] !== next[matched]) matched = prefix[matched - 1] ?? 0
    if (next[i] === next[matched]) matched++
    prefix[i] = matched
  }
  let matched = 0
  for (let i = 0; i < previous.length; i++) {
    const char = previous[i]
    while (matched && (matched === next.length || char !== next[matched])) matched = prefix[matched - 1] ?? 0
    if (char === next[matched]) matched++
  }
  return matched ? { reset: false, text: next.slice(matched) } : { reset: true, text: next }
}

/** The process port also caps UTF-8 bytes; never cut a surrogate pair or encoded character. */
export function terminalPaste(text: string): string {
  const encoder = new TextEncoder()
  let bytes = 0,
    end = 0
  for (const char of text) {
    const length = encoder.encode(char).length
    if (bytes + length > 65536) break
    bytes += length
    end += char.length
  }
  return text.slice(0, end)
}
