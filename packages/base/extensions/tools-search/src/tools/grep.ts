import { isAbsolute, join } from 'node:path'
import type { ToolResult } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import { scrubFeedback } from '../../../tools-core/src/guards/feedback.js'
import { cutHead, guardedResult } from '../../../tools-core/src/guards/output.js'
import { isBinary, loadSpilledLines, MAX_READ_BYTES } from '../../../tools-core/src/tools/read.js'
import { GrepParams } from '../../../tools-core/src/tools/schemas.js'
import { type FoundPath, referencedResult } from './references.js'
import {
  globToRegExp,
  newWalkReport,
  SEARCH_META,
  searchPathError,
  toolError,
  unreadable,
  walk,
  walkNotes,
} from './walk.js'

const dec = new TextDecoder()

// How much of a single matching line is shown. A minified bundle or a base64 blob is one line
// megabytes long, and the point of a match is to locate it, not to paste it.
const MAX_LINE = 500
const MAX_ENTRIES = 50_000
const DEFAULT_LIMIT = 100

function clip(s: string): string {
  return s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 3)}...` : s
}

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search file contents under a directory with a regular expression, or with a literal string when literal is true. Returns path:line:text, with context lines marked path-line-text. Build and dependency directories, binary files and paths policy denies are passed over, and the result says which. The path may also be an artifact:// path from a truncated output note, to search that output; the line numbers match what read shows.',
  parameters: GrepParams,
  meta: SEARCH_META,
  async execute(args, ctx): Promise<ToolResult> {
    const root = args.path ?? ctx.cwd
    const limit = args.limit ?? DEFAULT_LIMIT
    let re: RegExp
    try {
      re = new RegExp(
        args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : args.pattern,
        args.ignoreCase ? 'i' : '',
      )
    } catch {
      return toolError(
        `invalid pattern ${cutHead(scrubFeedback(JSON.stringify(args.pattern)), 160)}; correct the regular expression or set literal=true for exact text.`,
        'FS_INVALID_PATTERN',
      )
    }
    const glob = args.glob ? globToRegExp(args.glob) : undefined
    const report = newWalkReport()
    const out: string[] = []
    let matches = 0
    // The rows of `out` that hold a match rather than context.
    const matchRows: number[] = []
    let atLimit = false
    const context = args.context ?? 0
    // Matches one file's lines, as `label` and a 1-based line number. Shared by a file in the tree
    // and a stored output, so both are reported the same way and stop at the same limit.
    const searchLines = (label: string, lines: string[], numberOf = (i: number): number => i + 1): void => {
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i] as string)) continue
        if (matches >= limit) {
          atLimit = true
          return
        }
        matches++
        for (let j = Math.max(0, i - context); j < i; j++)
          out.push(`${label}-${numberOf(j)}-${clip(lines[j] as string)}`)
        matchRows.push(out.length)
        out.push(`${label}:${numberOf(i)}:${clip(lines[i] as string)}`)
        for (let j = i + 1; j <= Math.min(lines.length - 1, i + context); j++)
          out.push(`${label}-${numberOf(j)}-${clip(lines[j] as string)}`)
      }
    }
    if (args.path?.startsWith('artifact://')) {
      // A stored output is one file, whatever glob says. Whole lines are searched, so a match is not
      // lost to a fold, and each is reported at the row where its line begins: the offset to read from.
      const spilled = await loadSpilledLines(ctx, args.path)
      if (!spilled.ok) return toolError(spilled.message, 'FS_ARTIFACT_READ')
      searchLines(
        `artifact://${args.path.slice('artifact://'.length, 'artifact://'.length + 12)}`,
        spilled.logical,
        (i) => (spilled.starts[i] as number) + 1,
      )
      // Past the byte ceiling only the start was searched, which "no matches" must not hide.
      const notes = [...(spilled.notes ? [spilled.notes.trimEnd()] : [])]
      if (atLimit)
        notes.push(
          `[limit ${limit} reached; there may be more matches; narrow path/pattern or increase limit]`,
        )
      return guardedResult(ctx, [out.length > 0 ? out.join('\n') : 'no matches', ...notes].join('\n'))
    }
    const denied = searchPathError(ctx, 'grep', root)
    if (denied) return denied
    const found: FoundPath[] = []
    for await (const f of walk(ctx, root, report, { maxEntries: MAX_ENTRIES })) {
      if (atLimit) break
      if (f.kind !== 'file' || (f.abs !== root && glob && !glob.test(f.rel))) continue
      let bytes: Uint8Array
      try {
        // The size is asked about before the bytes are wanted, so one large file in the tree costs
        // a stat rather than the whole of it in memory. Skipping it is counted: a file left out
        // without a word reads as a file with no matches in it.
        const st = await ctx.fs.stat(f.abs)
        if (st.size > MAX_READ_BYTES) {
          report.oversize++
          continue
        }
        bytes = await ctx.fs.read(f.abs)
      } catch (error) {
        // One unreadable file must not end the turn: a permission error somewhere in a tree is
        // ordinary, and the search over the rest of it is still worth having.
        unreadable(report, f.rel, error)
        continue
      }
      if (isBinary(bytes)) {
        report.binary++
        continue
      }
      report.searched++
      const before = matchRows.length
      searchLines(f.rel, dec.decode(bytes).split('\n'))
      if (matchRows.length > before)
        found.push({
          // Resolved without the workspace fold, which would read a backslash in a name as a separator.
          abs: isAbsolute(f.abs) ? f.abs : join(ctx.cwd, f.abs),
          kind: 'file',
          rows: matchRows.slice(before).map((row) => ({ row, label: f.rel.length + 1 })),
        })
    }
    const notes = walkNotes(report, MAX_ENTRIES)
    if (atLimit)
      notes.push(`[limit ${limit} reached; there may be more matches; narrow path/pattern or increase limit]`)
    const failed = report.searched === 0 && (report.unreadable > 0 || report.binary > 0)
    const partial =
      atLimit || report.truncated || report.unreadable > 0 || report.oversize > 0 || report.binary > 0
    const text = [
      out.length > 0 ? out.join('\n') : failed ? 'nothing could be searched' : 'no matches',
      ...notes,
    ].join('\n')
    if (failed)
      return { ...(await guardedResult(ctx, text)), isError: true, details: { code: 'FS_SEARCH_UNREADABLE' } }
    return referencedResult(ctx, text, out, found, found.length, partial)
  },
})
