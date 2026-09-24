import { defineTool, type ToolResult } from '@agnes/extension-api'
import { guardedResult } from '../../../tools-core/src/guards/output.js'
import { FindParams } from '../../../tools-core/src/tools/schemas.js'
import { globToRegExp, newWalkReport, SEARCH_META, walk, walkNotes } from './walk.js'

const MAX_ENTRIES = 100_000
const DEFAULT_LIMIT = 1000

export const findTool = defineTool({
  name: 'find',
  description:
    'List files whose path relative to the search root matches a glob pattern (** spans directories, * stays within one path segment, ? is one character). Build and dependency directories and paths policy denies are passed over, and the result says which.',
  parameters: FindParams,
  meta: SEARCH_META,
  async execute(args, ctx): Promise<ToolResult> {
    const limit = args.limit ?? DEFAULT_LIMIT
    const re = globToRegExp(args.pattern)
    const report = newWalkReport()
    const out: string[] = []
    let atLimit = false
    for await (const f of walk(ctx, args.path ?? ctx.cwd, report, { maxEntries: MAX_ENTRIES })) {
      if (f.kind !== 'file' || !re.test(f.rel)) continue
      if (out.length >= limit) {
        atLimit = true
        break
      }
      out.push(f.rel)
    }
    const notes = walkNotes(report, MAX_ENTRIES)
    if (atLimit) notes.push(`[limit ${limit} reached; there may be more]`)
    return guardedResult(ctx, [out.length > 0 ? out.join('\n') : 'no matches', ...notes].join('\n'))
  },
})
