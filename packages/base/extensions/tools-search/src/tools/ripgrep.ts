import { basename, relative, resolve } from 'node:path'
import { defineTool, type ToolContext, type ToolResult } from '@agnes/extension-api'
import { guardedResult, refBlock, spillLocator } from '../../../tools-core/src/guards/output.js'
import { FindParams, GrepParams } from '../../../tools-core/src/tools/schemas.js'
import { grepTool as artifactGrep } from './grep.js'
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

async function files(ctx: ToolContext, root: string): Promise<{ paths: string[]; notes: string[] }> {
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
  if (r.code > 1 || r.code < 0) throw new Error(r.stderr || 'bundled ripgrep could not list files')
  const paths: string[] = []
  let denied = 0
  for (const path of r.stdout.split('\0').filter(Boolean)) {
    const abs = resolve(ctx.cwd, path)
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
  return { paths, notes }
}

async function result(
  ctx: ToolContext,
  lines: string[],
  limit: number,
  notes: string[],
): Promise<ToolResult> {
  const full = [...lines, ...notes].join('\n') || 'no matches'
  if (lines.length <= limit) return guardedResult(ctx, full)
  // Always spill on the caller's row limit, even if the byte guard would allow all rows.
  try {
    const ref = await ctx.artifacts.put(new TextEncoder().encode(full), { mime: 'text/plain' })
    const preview = [
      ...lines.slice(0, limit),
      `[limit ${limit} reached; full output stored at ${spillLocator(ref)}; use read with that path and offset/limit]`,
      ...notes,
    ].join('\n')
    const guarded = await guardedResult(ctx, preview)
    return {
      ...guarded,
      content: [...guarded.content, refBlock(ref)],
      details: { matches: lines.length, artifact: ref },
    }
  } catch {
    return guardedResult(
      ctx,
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
    const root = resolve(ctx.cwd, args.path ?? ctx.cwd)
    const denied = searchPathError(ctx, 'find', root)
    if (denied) return denied
    try {
      const listing = await files(ctx, root)
      const re = globToRegExp(args.pattern)
      const lines = listing.paths
        .map((p) => relative(root, p) || basename(p))
        .filter((p) => re.test(p))
        .sort()
      return result(ctx, lines, args.limit ?? 1000, listing.notes)
    } catch (e) {
      return toolError(`find failed: ${String(e)}`)
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
    const root = resolve(ctx.cwd, args.path ?? ctx.cwd)
    const denied = searchPathError(ctx, 'grep', root)
    if (denied) return denied
    try {
      const listing = await files(ctx, root)
      const glob = args.glob ? globToRegExp(args.glob) : undefined
      const paths = listing.paths.filter((p) => !glob || glob.test(relative(root, p) || basename(p)))
      const lines: string[] = []
      let captured = 0
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
        if (r.code > 1 || r.code < 0) throw new Error(r.stderr || 'bundled ripgrep failed')
        if (r.truncated) listing.notes.push('[match capture limit reached; search is partial]')
        for (const row of r.stdout.trimEnd().split('\n')) {
          if (!row) continue
          let item: {
            type: string
            data: { path?: { text?: string }; lines?: { text?: string }; line_number?: number }
          }
          try {
            item = JSON.parse(row)
          } catch {
            if (r.truncated) continue
            throw new Error('invalid ripgrep output')
          }
          if (item.type !== 'match' && item.type !== 'context') continue
          const p = item.data.path?.text
          const text = item.data.lines?.text
          if (!p || text === undefined || !batch.includes(p)) continue
          const separator = item.type === 'match' ? ':' : '-'
          const line = `${relative(root, p) || basename(p)}${separator}${item.data.line_number}${separator}${text.replace(/\r?\n$/, '')}`
          captured += Buffer.byteLength(line, 'utf8')
          if (captured > 4 * 1024 * 1024) break
          lines.push(line)
        }
        if (captured > 4 * 1024 * 1024) {
          listing.notes.push('[4 MiB aggregate match limit reached; search is partial]')
          break
        }
      }
      return result(ctx, lines, args.limit ?? 100, listing.notes)
    } catch (e) {
      return toolError(`grep failed: ${String(e)}`)
    }
  },
})
