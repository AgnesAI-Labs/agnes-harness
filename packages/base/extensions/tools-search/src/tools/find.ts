import { defineTool, type ToolResult } from '@agnes/extension-api'
import { guardOutput, refBlock } from '../../../tools-core/src/guards/output.js'
import { HOST_TOOL_FACT_CODEC, hostPathFact } from '../../../tools-core/src/tools/facts.js'
import { FindParams } from '../../../tools-core/src/tools/schemas.js'
import { globToRegExp, newWalkReport, SEARCH_META, searchPathError, walk, walkNotes } from './walk.js'

const MAX_ENTRIES = 100_000
const DEFAULT_LIMIT = 1000

export const findTool = defineTool({
  name: 'find',
  description:
    'List files whose path relative to the search root matches a glob pattern (** spans directories, * stays within one path segment, ? is one character). Build and dependency directories and paths policy denies are passed over, and the result says which.',
  parameters: FindParams,
  meta: SEARCH_META,
  async execute(args, ctx): Promise<ToolResult> {
    const root = args.path ?? ctx.cwd
    const denied = searchPathError(ctx, 'find', root)
    if (denied) return denied
    const limit = args.limit ?? DEFAULT_LIMIT
    const re = globToRegExp(args.pattern)
    const report = newWalkReport()
    const out: string[] = []
    const paths: string[] = []
    let atLimit = false
    for await (const f of walk(ctx, root, report, { maxEntries: MAX_ENTRIES })) {
      if (f.kind !== 'file' || !re.test(f.rel)) continue
      if (out.length >= limit) {
        atLimit = true
        break
      }
      out.push(f.rel)
      paths.push(hostPathFact(f.abs, ctx.cwd).path)
    }
    const notes = walkNotes(report, MAX_ENTRIES)
    if (atLimit) notes.push(`[limit ${limit} reached; there may be more]`)
    const guarded = await guardOutput(
      ctx,
      [out.length > 0 ? out.join('\n') : 'no matches', ...notes].join('\n'),
    )
    const skippedDirectories = [...report.skipped].sort()
    const complete =
      !atLimit &&
      !report.truncated &&
      !guarded.truncated &&
      skippedDirectories.length === 0 &&
      report.denied === 0 &&
      report.unreadable === 0
    const block = { type: 'text' as const, text: guarded.text }
    return {
      content: guarded.ref ? [block, refBlock(guarded.ref)] : [block],
      structured: {
        codec: HOST_TOOL_FACT_CODEC,
        tool: 'find',
        root: hostPathFact(root, ctx.cwd),
        query: { pattern: args.pattern, limit },
        paths,
        coverage: {
          complete,
          resultLimitReached: atLimit,
          walkLimitReached: report.truncated,
          outputTruncated: guarded.truncated,
          skippedDirectories,
          deniedPaths: report.denied,
          unreadablePaths: report.unreadable,
        },
      },
    }
  },
})
