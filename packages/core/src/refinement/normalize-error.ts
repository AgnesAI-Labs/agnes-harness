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
  return keyOf(firstText(result.content).split('\n'))
}

const STDERR_LABEL = /^\[stderr\]$/i
/** What the shell writes after a failing command's stderr: the retry advice and the `[exit N]` line. */
const SHELL_CLOSING = /^(?:\[exit -?\d+\]|command failed; inspect the output)/i

/**
 * The key for a command that exited non-zero: the error it wrote to stderr, not whatever stdout
 * came first. The stderr section runs from the shell's last `[stderr]` label to the shell's own
 * closing lines and goes through the same rule as any error text. With no stderr, or only blank
 * stderr, it is the first-line rule of `normalizeToolError`.
 *
 * Only the live trigger uses this: ledger rows do not keep the tool's code, so the offline
 * statistics tool cannot tell these failures apart and keeps the first-line rule.
 */
export function normalizeCommandError(content?: unknown[]): string {
  const lines = firstText(content).split('\n')
  const label = lines.findLastIndex((line) => STDERR_LABEL.test(line.trim()))
  if (label >= 0) {
    const stderr = lines.slice(label + 1)
    const closing = (line = '') => !line.trim() || SHELL_CLOSING.test(line.trim())
    while (stderr.length && closing(stderr.at(-1))) stderr.pop()
    const key = keyOf(stderr)
    if (key) return key
  }
  return keyOf(lines)
}

function firstText(content: unknown[] = []): string {
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
      return b.text
  }
  return ''
}

function keyOf(raw: string[]): string {
  const lines = raw.filter((line) => line.trim() && !STREAM_LABEL.test(line.trim()))
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
