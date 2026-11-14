import { createHash } from 'node:crypto'
import { redactSecrets, type ToolContext } from '@agnes/extension-api'
import { within } from '../deadline.js'
import type { Judge } from '../judge.js'
import { type FindFs, findRoot, readFindCandidate, scanFindCandidates } from './find-scan.js'
import { type FindStageStats, scoreFindEntries } from './find-stages.js'
import { type FindWindow, findWindows } from './find-windows.js'

type Range = { path: string; startLine: number; endLine: number; score: number }
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const rank = <T extends { path: string }>(a: { entry: T; score: number }, b: { entry: T; score: number }) =>
  b.score - a.score || compare(a.entry.path, b.entry.path)
function merge(ranges: Range[]): Range[] {
  const merged: Range[] = []
  for (const range of ranges.sort((a, b) => compare(a.path, b.path) || a.startLine - b.startLine)) {
    const last = merged.at(-1)
    if (last && last.path === range.path && range.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, range.endLine)
      last.score = Math.max(last.score, range.score)
    } else merged.push({ ...range })
  }
  return merged.sort((a, b) => b.score - a.score || compare(a.path, b.path) || a.startLine - b.startLine)
}
function boundedFiles(ctx: ToolContext, parent: AbortSignal, end: number) {
  const cutoff = new AbortController()
  const signal = AbortSignal.any([parent, cutoff.signal])
  const run = <T>(read: () => Promise<T>): Promise<T> => {
    if (Date.now() >= end) cutoff.abort(new DOMException('Find deadline', 'TimeoutError'))
    signal.throwIfAborted()
    return read()
  }
  const revision = ctx.fs.revision?.bind(ctx.fs)
  const fs: FindFs = {
    list: (path) => run(() => ctx.fs.list(path)),
    stat: (path) => run(() => ctx.fs.stat(path)),
    read: (path, options) => run(() => ctx.fs.read(path, options)),
    ...(revision ? { revision: (path: string) => run(() => revision(path)) } : {}),
  }
  return { fs, signal }
}
async function plainAncestors(
  fs: FindFs,
  workspace: string,
  requested: string,
  signal: AbortSignal,
): Promise<boolean> {
  const parts = requested.slice(workspace.length).split('/').filter(Boolean)
  let cursor = workspace
  for (const name of parts) {
    if ((await within(fs.stat(cursor), signal)).kind !== 'dir') return false
    cursor = `${cursor.replace(/\/$/, '')}/${name}`
  }
  return true
}
export async function findRelevant(
  judge: Judge,
  ctx: ToolContext,
  input: { query: string; path?: string },
  parentSignal: AbortSignal,
  end: number,
) {
  const { fs, signal } = boundedFiles(ctx, parentSignal, end)
  const stats: FindStageStats = { calls: [], failures: 0, successful: 0, reasons: new Set(), sequence: 0 }
  let filesJudged = 0
  let matches: Range[] = []
  const workspace = findRoot(ctx.session.workspaceRoot)
  const requested =
    input.path === undefined || input.path === '.'
      ? workspace
      : findRoot(/^(?:\/|[A-Za-z]:)/.test(input.path) ? input.path : `${workspace}/${input.path}`)
  try {
    if (
      !workspace ||
      !requested ||
      (requested !== workspace && !requested.startsWith(`${workspace.replace(/\/$/, '')}/`)) ||
      !(await plainAncestors(fs, workspace, requested, signal))
    )
      stats.reasons.add('unsafe_root')
    else {
      const scan = await scanFindCandidates(fs, requested, input.query, signal)
      stats.failures += scan.failures
      for (const reason of scan.reasons) stats.reasons.add(reason)
      const deps = {
        judge,
        query: input.query,
        signal,
        end,
        prefix: createHash('sha256').update(ctx.session.toolUseId).digest('hex').slice(0, 32),
        stats,
      }
      const names = await scoreFindEntries(deps, 'names', scan.candidates, 64, (entry) => ({
        path: redactSecrets(entry.path),
      }))
      names.sort(rank)
      if (names.length > 20) stats.reasons.add('semantic_file_limit')
      const windows: (FindWindow & { path: string })[] = []
      for (const { entry } of names.slice(0, 20)) {
        if (signal.aborted || Date.now() >= end) {
          stats.reasons.add('cancelled')
          break
        }
        const read = await readFindCandidate(fs, requested, entry.path, signal)
        if (read.status !== 'ok') {
          stats.failures++
          stats.reasons.add(read.reason)
          continue
        }
        filesJudged++
        if (read.truncated) stats.reasons.add('content_read_limit')
        const selected = findWindows(read.text, input.query)
        // The reader holds at most one fresh prefix; only bounded redacted windows survive it.
        windows.push(...selected.map((window) => ({ ...window, path: entry.path })))
        if (
          selected.length === 24 &&
          selected.reduce((sum, window) => sum + window.end - window.start, 0) < read.text.length
        )
          stats.reasons.add('window_limit')
      }
      const sketches = await scoreFindEntries(deps, 'sketches', windows, 46, (entry) => ({
        path: redactSecrets(entry.path),
        startLine: entry.startLine,
        endLine: entry.endLine,
        summary: entry.summary,
      }))
      const selected = sketches
        .filter((row) => row.score >= 0.45)
        .sort((a, b) => rank(a, b) || a.entry.start - b.entry.start)
      if (selected.length > 40) stats.reasons.add('verify_limit')
      const verified = await scoreFindEntries(
        deps,
        'verify',
        selected.slice(0, 40).map((row) => row.entry),
        4,
        (entry) => ({
          path: redactSecrets(entry.path),
          startLine: entry.startLine,
          endLine: entry.endLine,
          text: entry.text,
        }),
      )
      matches = merge(
        verified
          .filter((row) => row.score >= 0.2)
          .map(({ entry, score }) => ({
            path: entry.path,
            startLine: entry.startLine,
            endLine: entry.endLine,
            score,
          })),
      )
    }
  } catch {
    stats.reasons.add(signal.aborted ? 'cancelled' : 'scan_error')
    stats.failures++
  }
  const reasons = [...stats.reasons]
  return {
    matches,
    filesJudged,
    requestCount: stats.calls.filter((call) => !call.replayed && call.dispatch === 'may-have-sent').length,
    failures: stats.failures,
    partial: reasons.length > 0,
    reasons,
    accounting: { calls: stats.calls },
    billing: 'See original accounting; missing dollar billing is unknown.',
    message:
      matches.length === 0 && stats.failures > 0
        ? 'Judgment failed; this does not mean nothing was found. Please use grep.'
        : matches.length
          ? `Found ${matches.length} relevant source ranges.`
          : 'No relevant range confirmed; use grep if needed.',
  }
}
