import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { scrubFeedback, toolFailure } from '../guards/feedback.js'
import { cutHead } from '../guards/output.js'

const RECOVERY_HINT = {
  not_read: 'Use read on this file in this session before editing.',
  not_found:
    'Read the current range; later edits must target the intermediate content. Correct and resend the whole batch.',
  ambiguous:
    'Include distinguishing surrounding lines so oldText matches exactly once; resend the whole batch.',
  invalid_args: 'Check the requested path, text encoding and argument schema before retrying.',
  write_failed: 'Check write access and read the current file before retrying the batch.',
}

/** Index is zero-based; null means a file/batch-level failure, before a particular edit. */
export async function editFailure(
  ctx: ToolContext,
  code: string,
  category: 'not_read' | 'not_found' | 'ambiguous' | 'invalid_args' | 'write_failed',
  index: number | null,
  written: boolean | 'unknown',
  message: string,
): Promise<ToolResult> {
  const result = await toolFailure(ctx, code, message)
  const feedback = { category, index, written, hint: RECOVERY_HINT[category] }
  return { ...result, structured: feedback, details: { code, ...feedback } }
}

// Diagnostics never perform I/O or mutate text. Bound both input and candidate comparisons, even
// for minified files or adversarial oldText. Exact replacement has its own unchanged semantics.
const MAX_FILE = 256 * 1024
const MAX_NEEDLE = 8192
const MAX_LINES = 20000
const MAX_CANDIDATES = 12
const MAX_MATCHES = 20
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const whitespace = (s: string) =>
  lf(s)
    .split('\n')
    .map((l) => l.replace(/[\t ]+/g, ''))
    .join('\n')
const unicode = (s: string) => s.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')

/** Count overlapping matches (also ambiguity), but retain only a bounded list of line numbers. */
export function matchLocations(text: string, needle: string): { count: number; lines: number[] } {
  if (!needle) return { count: 0, lines: [] }
  let count = 0,
    from = 0,
    scanned = 0,
    line = 1
  const lines: number[] = []
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) return { count, lines }
    count++
    if (lines.length < MAX_MATCHES) {
      for (; scanned < at; scanned++) if (text[scanned] === '\n') line++
      lines.push(line)
    }
    from = at + 1
  }
}

function grams(s: string): Set<string> {
  const value = unicode(whitespace(s)).slice(0, 1024)
  const out = new Set<string>()
  for (let i = 0; i < value.length - 1; i++) out.add(value.slice(i, i + 2))
  if (value.length === 1) out.add(value)
  return out
}

export function mismatchFeedback(text: string, oldText: string): string {
  if (text.length > MAX_FILE || oldText.length > MAX_NEEDLE)
    return 'Candidate scan skipped (limit: 256 Ki characters per file, 8192 per oldText); use grep to locate the block, then read a small range.'
  const lines = text.split('\n')
  const wanted = oldText.split('\n')
  if (lines.length > MAX_LINES || wanted.length > 80)
    return 'Candidate scan skipped (limit: 20000 file lines, 80 oldText lines); use grep, then read a small range.'
  // Prefer an informative line over a common opener such as `if (` or `{`.
  const anchors = wanted.map(grams)
  const anchor = anchors.reduce((best, value, i) => (value.size > (anchors[best]?.size ?? 0) ? i : best), 0)
  const tokens = anchors[anchor] ?? new Set<string>()
  if (!tokens.size)
    return 'No useful candidate anchor; read the intended range and copy its exact whitespace.'
  const candidates: { start: number; score: number }[] = []
  for (let i = Math.max(0, anchor); i < lines.length; i++) {
    const actual = grams(lines[i] as string)
    let shared = 0
    for (const token of tokens) if (actual.has(token)) shared++
    const score = (2 * shared) / (tokens.size + actual.size)
    if (score < 0.35) continue
    candidates.push({ start: i - Math.max(0, anchor), score })
    candidates.sort((a, b) => b.score - a.score || a.start - b.start)
    if (candidates.length > MAX_CANDIDATES) candidates.pop()
  }
  if (!candidates.length)
    return 'No close candidate found; use grep for a distinctive fragment, then read its surrounding lines.'
  // Rank retained regions by the whole block too, so equal anchors with different surroundings
  // do not put unrelated blocks ahead of a close candidate. Only 12 bounded windows reach here.
  const blockTokens = grams(oldText)
  for (const candidate of candidates) {
    const block = grams(lines.slice(candidate.start, candidate.start + wanted.length).join('\n'))
    let shared = 0
    for (const token of blockTokens) if (block.has(token)) shared++
    candidate.score = candidate.score / 4 + (1.5 * shared) / (blockTokens.size + block.size)
  }
  candidates.sort((a, b) => b.score - a.score || a.start - b.start)
  const reports = candidates.slice(0, 3).map(({ start }) => {
    const actual = lines.slice(start, start + wanted.length).join('\n')
    // A search block can start/end inside a line, so use containment rather than line equality.
    const cause = lf(actual).includes(lf(oldText))
      ? 'line-ending difference (LF/CRLF)'
      : whitespace(actual).includes(whitespace(oldText))
        ? 'whitespace/indentation-only difference (tabs, spaces or trailing whitespace)'
        : unicode(actual).includes(unicode(oldText))
          ? 'quote/unicode-normalisation difference'
          : 'similar text; check changed content or surrounding lines'
    const excerpt = lines
      .slice(start, start + Math.min(wanted.length + 1, 6))
      .map(
        (line, i) =>
          `${start + i + 1}: ${JSON.stringify(cutHead(scrubFeedback(line), 240))}${line.length > 240 ? ' [excerpt cut; read this line]' : ''}`,
      )
      .join('\n')
    return `Candidate at line ${start + 1}: ${cause}. Actual text (JSON-escaped):\n${excerpt}`
  })
  return `${reports.join('\n')}\nRead the indicated range if clipped; copy actual text exactly, without line numbers or JSON escaping, into oldText.`
}
