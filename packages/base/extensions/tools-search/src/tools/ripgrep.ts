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

// A home directory or a disk root can hold millions of files. The listing is bounded in time, depth
// and count, and what it found by then is searched and called partial, instead of the call running
// out its whole budget and returning nothing.
const LIST_MS = 30_000
const MAX_DEPTH = 32
const MAX_LISTED = 50_000
/** How long grep may run, the listing included, before it stops and reports what it found. */
const SEARCH_MS = 60_000

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
    [
      ripgrepPath(),
      '--files',
      '--null',
      '--hidden',
      '--no-ignore',
      '--max-depth',
      String(MAX_DEPTH),
      ...globs,
      '--',
      root,
    ],
    { cwd: ctx.cwd, timeoutMs: LIST_MS },
  )
  // Exit 2 with a listing is a tree with an unreadable directory somewhere in it, which every home
  // directory has: the rest of the tree is still worth searching, and the note below names the gap.
  if ((r.code < 0 && !r.timedOut) || (!r.stdout && (r.code > 1 || (r.code === 1 && r.stderr))))
    throw new Error(r.stderr || 'bundled ripgrep could not list files')
  const cut = r.truncated || r.timedOut === true
  const listed = r.stdout.split('\0')
  // A listing cut short may end inside a path; that piece names no file.
  if (cut) listed.pop()
  const entries = listed.filter(Boolean)
  const overCount = entries.length > MAX_LISTED
  if (overCount) entries.length = MAX_LISTED
  const paths: string[] = []
  let denied = 0,
    deepest = 0
  for (const path of entries) {
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
    deepest = Math.max(deepest, searchRelative(root, abs).split('/').length)
  }
  // A file at the depth limit is the only sign the limit was reached: rg lists it, and does not
  // enter the directories beside it.
  const tooDeep = deepest >= MAX_DEPTH
  const notes = [`[not searched: ${[...DEFAULT_SKIP].sort().join(', ')}; symlinks are not followed]`]
  if (denied) notes.push(`[${denied} path(s) skipped: outside the workspace, unreadable or denied by policy]`)
  if (r.truncated) notes.push('[file listing capture limit reached; search is partial]')
  if (r.timedOut)
    notes.push(`[file listing stopped after ${LIST_MS / 1000} s; search is partial; narrow path]`)
  if (overCount) notes.push(`[file listing stopped at ${MAX_LISTED} files; search is partial; narrow path]`)
  if (tooDeep)
    notes.push(`[directories more than ${MAX_DEPTH} levels below the search root were not searched]`)
  if (r.stderr) notes.push(`[listing incomplete: ${r.stderr.slice(0, 2000).trim()}]`)
  return { paths, notes, namedFile, partial: cut || overCount || tooDeep || r.stderr !== '' }
}

/**
 * Which of the sorted `rels` a page of `max` rows shows. Every top-level entry gets a path before
 * any gets a second, so one large directory cannot fill the page and hide all the others. The
 * picked rows keep their sorted order, so the page still reads as one sorted list.
 */
function sampleAcrossTopLevel(rels: readonly string[], max: number) {
  const groups = new Map<string, number[]>()
  rels.forEach((rel, i) => {
    const key = rel.split('/')[0] ?? rel
    const group = groups.get(key)
    if (group) group.push(i)
    else groups.set(key, [i])
  })
  const picked = new Set<number>()
  let active = [...groups.values()]
  for (let round = 0; active.length > 0 && picked.size < max; round++) {
    for (const group of active) {
      if (picked.size >= max) break
      picked.add(group[round] as number)
    }
    active = active.filter((group) => group.length > round + 1)
  }
  let shown = 0
  for (const group of groups.values()) if (picked.has(group[0] as number)) shown++
  // Whether the page differs from the first `max` rows, which is what it would otherwise be.
  const reordered = [...picked].some((i) => i >= max)
  return { picked, shown, total: groups.size, reordered }
}

async function result(
  ctx: ToolContext,
  lines: string[],
  limit: number,
  notes: string[],
  refs?: { found: FoundPath[]; shown: number; partial: boolean },
  // The rows shown when there are more than `limit`; the head of `lines` unless the caller chose.
  page = lines.slice(0, limit),
): Promise<ToolResult> {
  // Every text below starts with the rows the result shows, which is what the references are of.
  const guard = (text: string) =>
    refs === undefined
      ? guardedResult(ctx, text)
      : referencedResult(ctx, text, page, refs.found, refs.shown, refs.partial)
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
      ...page,
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
    return guard([...page, `[limit ${limit} reached; full output could not be stored]`, ...notes].join('\n'))
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
      const limit = args.limit ?? 100
      const sample = sampleAcrossTopLevel(lines, limit)
      const page = matched.filter((_, i) => sample.picked.has(i))
      // The shown paths first, each at its row of the page, then the rest of what was found.
      const found = [...page, ...matched.filter((_, i) => !sample.picked.has(i))].map(
        (p, row): FoundPath => ({
          abs: p.abs,
          kind: 'file',
          ...(row < page.length ? { rows: [{ row, label: p.rel.length }] } : {}),
        }),
      )
      const notes =
        lines.length > limit && sample.reordered
          ? [
              `[shown: up to ${limit} paths sampled across ${sample.shown} of ${sample.total} top-level entries, not the first ${limit} in order; narrow path to list one subtree]`,
              ...listing.notes,
            ]
          : listing.notes
      return result(
        ctx,
        lines,
        limit,
        notes,
        { found, shown: page.length, partial: listing.partial },
        page.map((p) => p.rel),
      )
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
    const deadline = Date.now() + SEARCH_MS
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
      let stoppedAt: number | undefined
      for (let i = 0; i < paths.length; i += 128) {
        const left = deadline - Date.now()
        if (left <= 0) {
          stoppedAt = i
          break
        }
        const batch = paths.slice(i, i + 128)
        const flags = [
          ...(args.ignoreCase ? ['--ignore-case'] : []),
          ...(args.literal ? ['--fixed-strings'] : []),
          '--context',
          String(args.context ?? 0),
        ]
        const r = await ctx.exec([ripgrepPath(), '--json', ...flags, '-e', args.pattern, '--', ...batch], {
          cwd: ctx.cwd,
          timeoutMs: left,
        })
        if (r.timedOut) stoppedAt = i
        else if ((r.code > 1 || r.code < 0) && !r.stdout)
          throw new Error(r.stderr || 'bundled ripgrep failed')
        if (!r.timedOut && (r.code > 1 || r.code < 0)) failedSearch = true
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
            if (r.truncated || r.timedOut) continue
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
        if (stoppedAt !== undefined) break
      }
      if (stoppedAt !== undefined) {
        partial = true
        listing.notes.push(
          `[search stopped after ${SEARCH_MS / 1000} s with ${paths.length - stoppedAt} of ${paths.length} file(s) not searched completely; narrow path/pattern]`,
        )
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
