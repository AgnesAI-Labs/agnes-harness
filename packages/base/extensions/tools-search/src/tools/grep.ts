import { defineTool, type ToolResult } from '@agnes/extension-api'
import { guardedResult } from '../../../tools-core/src/guards/output.js'
import { isBinary, loadSpilledLines, MAX_READ_BYTES } from '../../../tools-core/src/tools/read.js'
import { GrepParams } from '../../../tools-core/src/tools/schemas.js'
import { globToRegExp, newWalkReport, SEARCH_META, toolError, walk, walkNotes } from './walk.js'

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
    const limit = args.limit ?? DEFAULT_LIMIT
    let re: RegExp
    try {
      re = new RegExp(
        args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : args.pattern,
        args.ignoreCase ? 'i' : '',
      )
    } catch (e) {
      return toolError(`invalid pattern: ${(e as Error).message}`)
    }
    const glob = args.glob ? globToRegExp(args.glob) : undefined
    const report = newWalkReport()
    const out: string[] = []
    let matches = 0
    let atLimit = false
    const context = args.context ?? 0
    // Matches one file's lines, as `label` and a 1-based line number. Shared by a file in the tree
    // and a stored output, so both are reported the same way and stop at the same limit.
    const searchLines = (label: string, lines: string[]): void => {
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i] as string)) continue
        if (matches >= limit) {
          atLimit = true
          return
        }
        matches++
        for (let j = Math.max(0, i - context); j < i; j++)
          out.push(`${label}-${j + 1}-${clip(lines[j] as string)}`)
        out.push(`${label}:${i + 1}:${clip(lines[i] as string)}`)
        for (let j = i + 1; j <= Math.min(lines.length - 1, i + context); j++)
          out.push(`${label}-${j + 1}-${clip(lines[j] as string)}`)
      }
    }
    if (args.path?.startsWith('artifact://')) {
      // A stored output is one file, whatever glob says. Its lines are the ones read pages through,
      // so a line number found here is the offset to read from.
      const spilled = await loadSpilledLines(ctx, args.path)
      if (!spilled.ok) return toolError(spilled.message)
      searchLines(
        `artifact://${args.path.slice('artifact://'.length, 'artifact://'.length + 12)}`,
        spilled.lines,
      )
      const notes = atLimit ? [`[limit ${limit} reached; there may be more matches]`] : []
      return guardedResult(ctx, [out.length > 0 ? out.join('\n') : 'no matches', ...notes].join('\n'))
    }
    for await (const f of walk(ctx, args.path ?? ctx.cwd, report, { maxEntries: MAX_ENTRIES })) {
      if (atLimit) break
      if (f.kind !== 'file' || (glob && !glob.test(f.rel))) continue
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
      } catch {
        // One unreadable file must not end the turn: a permission error somewhere in a tree is
        // ordinary, and the search over the rest of it is still worth having.
        report.unreadable++
        continue
      }
      if (isBinary(bytes)) continue
      searchLines(f.rel, dec.decode(bytes).split('\n'))
    }
    const notes = walkNotes(report, MAX_ENTRIES)
    if (atLimit) notes.push(`[limit ${limit} reached; there may be more matches]`)
    return guardedResult(ctx, [out.length > 0 ? out.join('\n') : 'no matches', ...notes].join('\n'))
  },
})
