import type { Diagnostic } from './client.js'

/** What one `lsp_diagnostics` path came to: diagnostics, or the reason there are none to report. */
export type FileReport = { path: string; diags?: readonly Diagnostic[]; note?: string }
export type Severity = 'error' | 'warning' | 'all'

const AUTO_MAX_LINES = 20
const AUTO_MAX_BYTES = 4096
const TOOL_MAX_LINES = 50
const severityOf = (d: Diagnostic) => d.severity ?? 1
const NAMES: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

const byPosition = (a: Diagnostic, b: Diagnostic) =>
  severityOf(a) - severityOf(b) ||
  a.range.start.line - b.range.start.line ||
  a.range.start.character - b.range.start.character

function line(d: Diagnostic, withSeverity: boolean): string {
  const origin = [d.source, d.code].filter((part) => part !== undefined && part !== '').join(' ')
  const message = d.message.replace(/\s*\n\s*/g, ' ').trim()
  return `${d.range.start.line + 1}:${d.range.start.character + 1} ${withSeverity ? `${NAMES[severityOf(d)] ?? 'error'} ` : ''}${message}${origin ? ` (${origin})` : ''}`
}

function fit(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const cut = Buffer.from(text)
    .subarray(0, Math.max(0, maxBytes - 16))
    .toString('utf8')
  return `${cut.replace(/�$/, '')}\n… (truncated)`
}

/**
 * The block appended to a write/edit result: errors only, nothing at all when there are none.
 * cli-tui recognises it by the head line `LSP found N error(s) in PATH:` and the `line:col message`
 * rows (packages/cli-tui/src/views/lsp-note.ts); change the format there too.
 */
export function formatAuto(
  path: string,
  diags: readonly Diagnostic[],
  maxBytes = AUTO_MAX_BYTES,
): string | undefined {
  const errors = diags.filter((d) => severityOf(d) === 1).sort(byPosition)
  if (errors.length === 0) return undefined
  const lines = errors.slice(0, AUTO_MAX_LINES).map((d) => line(d, false))
  if (errors.length > AUTO_MAX_LINES) lines.push(`… ${errors.length - AUTO_MAX_LINES} more`)
  const head = `LSP found ${errors.length} error${errors.length === 1 ? '' : 's'} in ${path}:`
  return fit([head, ...lines].join('\n'), Math.min(maxBytes, AUTO_MAX_BYTES))
}

/** The `lsp_diagnostics` answer: a summary, then each file's diagnostics (deduplicated, worst first). */
export function formatTool(reports: readonly FileReport[], severity: Severity): string {
  const all = reports.flatMap((r) => r.diags ?? [])
  const errors = all.filter((d) => severityOf(d) === 1).length
  const warnings = all.filter((d) => severityOf(d) === 2).length
  const keep = (d: Diagnostic) =>
    severity === 'all' ? true : severityOf(d) <= (severity === 'error' ? 1 : 2)
  const out = [
    `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} in ${reports.length} file${reports.length === 1 ? '' : 's'}`,
  ]
  for (const report of reports) {
    if (!report.diags) {
      out.push(`${report.path}: not checked - ${report.note ?? 'no result'}`)
      continue
    }
    const seen = new Set<string>()
    const shown = report.diags
      .filter(keep)
      .sort(byPosition)
      .filter((d) => {
        const key = `${JSON.stringify(d.range)}\0${d.message}`
        return !seen.has(key) && seen.add(key)
      })
    if (shown.length === 0) {
      out.push(
        `${report.path}: no ${severity === 'error' ? 'errors' : severity === 'warning' ? 'errors or warnings' : 'diagnostics'}`,
      )
      continue
    }
    out.push(`${report.path}:`, ...shown.slice(0, TOOL_MAX_LINES).map((d) => `  ${line(d, true)}`))
    if (shown.length > TOOL_MAX_LINES) out.push(`  … ${shown.length - TOOL_MAX_LINES} more`)
  }
  return out.join('\n')
}
