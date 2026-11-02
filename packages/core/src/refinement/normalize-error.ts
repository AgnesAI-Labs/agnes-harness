/**
 * A stable key for "the same error": the code if there is one, else a masked first line of text.
 * Shell results start with a stream label (`[stderr]`, `[stdout]`) that says nothing about the
 * error, so labels are skipped: otherwise every failing shell call would look like the same error.
 *
 * The same rule lives in `tools/rsi-eval/ledger-source.ts` (an offline statistics tool that cannot
 * import from Core); change both together.
 */
const STREAM_LABEL = /^\[(?:stderr|stdout)\]$/i
const PYTHON_TRACEBACK = /^traceback \(most recent call last\):?$/i

export function normalizeToolError(result: { code?: string; content?: unknown[] }): string {
  if (result.code) return result.code
  let text = ''
  for (const block of result.content ?? []) {
    const b = block as { type?: unknown; text?: unknown } | null
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      text = b.text
      break
    }
  }
  const lines = text.split('\n').filter((line) => line.trim() && !STREAM_LABEL.test(line.trim()))
  // A Python traceback starts with the same header whatever went wrong; its last line names the exception.
  const first = lines[0] ?? ''
  const key = PYTHON_TRACEBACK.test(first.trim()) ? (lines.at(-1) ?? '') : first
  return key
    .trim()
    .toLowerCase()
    .replace(/(?<![\w.])(?:\/|[a-z]:\\)[^\s'"`<>()]+/g, '<path>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<hex>')
    .replace(/\d+/g, '#')
    .slice(0, 120)
}
