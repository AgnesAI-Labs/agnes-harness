import { basename, relative, sep } from 'node:path'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import { fsFailure, scrubFeedback, toolFailure } from '../../../tools-core/src/guards/feedback.js'
import { cutHead, guardedResult, refBlock, spillLocator } from '../../../tools-core/src/guards/output.js'
import { normalizeWorkspacePath } from '../../../tools-core/src/paths.js'
import { MAX_ARTIFACT_READ_BYTES } from '../../../tools-core/src/tools/read.js'
import { FindParams, GrepParams } from '../../../tools-core/src/tools/schemas.js'
import { findTool as fallbackFind } from './find.js'
import { grepTool as artifactGrep } from './grep.js'
import { type FoundPath, type Row, referencedResult } from './references.js'
import { ripgrepPath } from './rg-path.js'
import {
  allowed,
  DEFAULT_SKIP,
  DENIED_PATHS,
  globToRegExp,
  SEARCH_META,
  searchPathError,
  toolError,
} from './walk.js'

// Globs and search output use '/', while filesystem calls keep native paths.
// On POSIX a backslash is a filename character, not a directory separator.
const searchRelative = (root: string, path: string) =>
  (relative(root, path) || basename(path)).split(sep).join('/')

const unavailable = (error: unknown) =>
  ['ENOENT', 'EACCES', 'MODULE_NOT_FOUND', 'SANDBOX_UNAVAILABLE'].includes(
    String((error as { code?: string })?.code),
  )

async function files(
  ctx: ToolContext,
  root: string,
): Promise<{ paths: string[]; notes: string[]; namedFile: boolean; partial: boolean }> {
  const kind = (await ctx.fs.stat(root)).kind
  if (kind === 'symlink') await ctx.fs.read(root, { limit: 1 })
  const namedFile = kind === 'file' || kind === 'symlink'
  if (namedFile) return { paths: [root], notes: [], namedFile, partial: false }
  // --no-ignore preserves the existing tool's explicit skips; never follow symlinks.
  const globs = [...new Set([...DEFAULT_SKIP, ...DENIED_PATHS])].flatMap((p) => [
    '--glob',
    `!${p}/**`,
    '--glob',
    `!${p}`,
  ])
  const r = await ctx.exec(
    [ripgrepPath(), '--files', '--null', '--hidden', '--no-ignore', ...globs, '--', root],
    { cwd: ctx.cwd },
  )
  if (r.code > 1 || r.code < 0 || (r.code === 1 && r.stderr))
    throw new Error(r.stderr || 'bundled ripgrep could not list files')
  const paths: string[] = []
  let denied = 0
  for (const path of r.stdout.split('\0').filter(Boolean)) {
    const abs = normalizeWorkspacePath(path, ctx.cwd).abs
    if (!allowed(ctx, abs)) {
      denied++
      continue
    }
    try {
      if ((await ctx.fs.stat(abs)).kind === 'file') paths.push(abs)
    } catch {
      denied++
    }
  }
  const notes = [`[not searched: ${[...DEFAULT_SKIP].sort().join(', ')}; symlinks are not followed]`]
  if (denied) notes.push(`[${denied} path(s) skipped: outside the workspace, unreadable or denied by policy]`)
  if (r.truncated) notes.push('[file listing capture limit reached; search is partial]')
  if (r.stderr) notes.push(`[listing incomplete: ${r.stderr.slice(0, 2000).trim()}]`)
  return { paths, notes, namedFile, partial: r.truncated || r.stderr !== '' }
}

async function result(
  ctx: ToolContext,
  lines: string[],
  limit: number,
  notes: string[],
  refs?: { found: FoundPath[]; shown: number; partial: boolean },
): Promise<ToolResult> {
  // Every text below starts with the rows the result shows, which is what the references are of.
  const guard = (text: string) =>
    refs === undefined
      ? guardedResult(ctx, text)
      : referencedResult(ctx, text, lines.slice(0, limit), refs.found, refs.shown, refs.partial)
  const full = [...(lines.length ? lines : ['no matches']), ...notes].join('\n')
  const bytes = new TextEncoder().encode(full)
  if (bytes.length > MAX_ARTIFACT_READ_BYTES)
    return toolError(
      `search output is ${bytes.length} bytes, exceeding the 32 MiB artifact limit; narrow path/pattern`,
      'FS_SEARCH_SIZE_LIMIT',
    )
  if (lines.length <= limit) return guard(full)
  // Always spill on the caller's row limit, even if the byte guard would allow all rows.
  try {
    const ref = await ctx.artifacts.put(bytes, { mime: 'text/plain' })
    const preview = [
      ...lines.slice(0, limit),
      `[limit ${limit} reached; full output stored at ${spillLocator(ref)}; use read with that path and offset/limit]`,
      ...notes,
    ].join('\n')
    const guarded = await guard(preview)
    return {
      ...guarded,
      content: [...guarded.content, refBlock(ref)],
      details: { matches: lines.length, artifact: ref },
    }
  } catch {
    return guard(
      [...lines.slice(0, limit), `[limit ${limit} reached; full output could not be stored]`, ...notes].join(
        '\n',
      ),
    )
  }
}

export const ripgrepFindTool = defineTool({
  name: 'find',
  description:
    'List files matching a glob using bundled ripgrep. Skips build/dependency and denied paths without following symlinks. Results beyond limit are stored as an artifact readable with read.',
  parameters: FindParams,
  meta: SEARCH_META,
  async execute(args, ctx) {
    const root = normalizeWorkspacePath(args.path ?? ctx.cwd, ctx.cwd).abs
    const denied = searchPathError(ctx, 'find', root)
    if (denied) return denied
    try {
      const listing = await files(ctx, root)
      const re = globToRegExp(args.pattern)
      const matched = listing.paths
        .map((abs) => ({ abs, rel: searchRelative(root, abs) }))
        .filter((p) => re.test(p.rel))
        .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
      const lines = matched.map((p) => p.rel)
      const limit = args.limit ?? 1000
      const found = matched.map(
        (p, row): FoundPath => ({ abs: p.abs, kind: 'file', rows: [{ row, label: p.rel.length }] }),
      )
      const shown = Math.min(found.length, limit)
      return result(ctx, lines, limit, listing.notes, { found, shown, partial: listing.partial })
    } catch (e) {
      if (unavailable(e)) return fallbackFind.execute(args, ctx)
      return fsFailure(ctx, 'find', args.path ?? ctx.cwd, e)
    }
  },
})

export const ripgrepGrepTool = defineTool({
  name: 'grep',
  description:
    'Search file contents with bundled ripgrep regular expressions (literal for exact text). Returns path:line:text and optional context. Does not follow symlinks or search denied/build/dependency paths. Results beyond limit spill to an artifact readable with read; artifact paths may also be searched.',
  parameters: GrepParams,
  meta: SEARCH_META,
  async execute(args, ctx) {
    if (args.path?.startsWith('artifact://')) return artifactGrep.execute(args, ctx)
    const root = normalizeWorkspacePath(args.path ?? ctx.cwd, ctx.cwd).abs
    const denied = searchPathError(ctx, 'grep', root)
    if (denied) return denied
    try {
      const listing = await files(ctx, root)
      const glob = args.glob ? globToRegExp(args.glob) : undefined
      const paths = listing.paths.filter(
        (p) => listing.namedFile || !glob || glob.test(searchRelative(root, p)),
      )
      const lines: string[] = []
      // Each file with a match, once, in the order first seen, with the rows its matches are on.
      const matchRows = new Map<string, Row[]>()
      let captured = 0,
        binary = 0,
        failedSearch = false,
        partial = listing.partial
      // Batches bound argv and each executor capture. No model-controlled flag enters argv.
      for (let i = 0; i < paths.length; i += 128) {
        const batch = paths.slice(i, i + 128)
        const flags = [
          ...(args.ignoreCase ? ['--ignore-case'] : []),
          ...(args.literal ? ['--fixed-strings'] : []),
          '--context',
          String(args.context ?? 0),
        ]
        const r = await ctx.exec([ripgrepPath(), '--json', ...flags, '-e', args.pattern, '--', ...batch], {
          cwd: ctx.cwd,
        })
        if ((r.code > 1 || r.code < 0) && !r.stdout) throw new Error(r.stderr || 'bundled ripgrep failed')
        if (r.code > 1 || r.code < 0) failedSearch = true
        if (r.truncated || r.stderr !== '') partial = true
        if (r.stderr) listing.notes.push(`[search incomplete: ${r.stderr.slice(0, 2000).trim()}]`)
        if (r.truncated) listing.notes.push('[match capture limit reached; search is partial]')
        for (const row of r.stdout.trimEnd().split('\n')) {
          if (!row) continue
          let item: {
            type: string
            data: {
              path?: { text?: string }
              lines?: { text?: string }
              line_number?: number
              binary_offset?: number | null
            }
          }
          try {
            item = JSON.parse(row)
          } catch {
            if (r.truncated) continue
            throw new Error('invalid ripgrep output')
          }
          if (item.type === 'end' && typeof item.data.binary_offset === 'number') binary++
          if (item.type !== 'match' && item.type !== 'context') continue
          const p = item.data.path?.text
          const text = item.data.lines?.text
          if (!p || text === undefined || !batch.includes(p)) continue
          const separator = item.type === 'match' ? ':' : '-'
          const name = searchRelative(root, p)
          const line = `${name}${separator}${item.data.line_number}${separator}${text.replace(/\r?\n$/, '')}`
          captured += Buffer.byteLength(line, 'utf8')
          if (captured > 4 * 1024 * 1024) break
          if (item.type === 'match') {
            const row = { row: lines.length, label: name.length + 1 }
            const rows = matchRows.get(p)
            if (rows) rows.push(row)
            else matchRows.set(p, [row])
          }
          lines.push(line)
        }
        if (captured > 4 * 1024 * 1024) {
          listing.notes.push('[4 MiB aggregate match limit reached; search is partial]')
          break
        }
      }
      if (binary) listing.notes.push(`[${binary} binary file(s) not searched completely]`)
      const failed = !lines.length && (failedSearch || (binary > 0 && binary === paths.length))
      const limit = args.limit ?? 100
      partial ||= captured > 4 * 1024 * 1024 || failedSearch || binary > 0
      const found = [...matchRows].map(([abs, rows]): FoundPath => ({ abs, kind: 'file', rows }))
      const shown = found.filter((f) => (f.rows?.[0]?.row ?? limit) < limit).length
      const response = await result(
        ctx,
        failed ? ['nothing could be searched'] : lines,
        limit,
        listing.notes,
        failed ? undefined : { found, shown, partial },
      )
      return failed ? { ...response, isError: true, details: { code: 'FS_SEARCH_UNREADABLE' } } : response
    } catch (e) {
      if (unavailable(e)) return artifactGrep.execute(args, ctx)
      if (e instanceof Error && e.message.includes('regex parse error'))
        return toolFailure(
          ctx,
          'FS_INVALID_PATTERN',
          `grep pattern ${cutHead(scrubFeedback(JSON.stringify(args.pattern)), 160)} is not a valid regular expression; correct it or use literal=true.`,
        )
      return fsFailure(ctx, 'grep (check pattern or use literal=true)', args.path ?? ctx.cwd, e)
    }
  },
})
