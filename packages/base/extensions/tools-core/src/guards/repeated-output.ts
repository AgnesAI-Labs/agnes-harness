/** Final screen retained verbatim before the ordinary byte/line truncation guard. */
export const OUTPUT_SCREEN_LINES = 40

// Only numeric fields change. Punctuation, whitespace and all other text must match, including
// paths and diagnostic wording. Never merge separate runs, even if their fingerprints match.
const fingerprint = (line: string) => JSON.stringify(line.split(/\d+/))
const diagnostic = /\b(?:error\w*|fail\w*|fatal|exception|panic|warning|warn)\b/i
const status = /\b(?:exit|status|completed|killed|running)\b/i

export function collapseRepeatedLines(text: string): string {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const boundary = Math.max(0, lines.length - OUTPUT_SCREEN_LINES)
  const seenErrors = new Set<string>()
  const output: string[] = []
  let i = 0
  while (i < boundary) {
    const first = lines[i]!
    const key = fingerprint(first)
    let end = i + 1
    while (end < boundary && fingerprint(lines[end]!) === key) end++
    let omitted = 0
    const flush = () => {
      if (omitted) output.push(`… repeated ${omitted} times …\n`)
      omitted = 0
    }
    for (let j = i; j < end; j++) {
      const line = lines[j]!
      const error = diagnostic.test(line)
      const keep = j === i || status.test(line) || (error && !seenErrors.has(line))
      if (error) seenErrors.add(line)
      if (keep) {
        flush()
        output.push(line)
      } else omitted++
    }
    flush()
    i = end
  }
  output.push(lines.slice(boundary).join(''))
  const result = output.join('')
  const encoder = new TextEncoder()
  return encoder.encode(result).length < encoder.encode(text).length ? result : text
}
