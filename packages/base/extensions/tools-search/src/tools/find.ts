import { isAbsolute, join } from 'node:path'
import { defineTool } from '@agnes/plugin-runtime'
import { guardedResult } from '../../../tools-core/src/guards/output.js'
import { FindParams } from '../../../tools-core/src/tools/schemas.js'
import { type FoundPath, referencedResult } from './references.js'
import { globToRegExp, newWalkReport, SEARCH_META, searchPathError, walk, walkNotes } from './walk.js'

/** Filesystem-only fallback when the Host cannot launch the bundled search executable. */
export const findTool = defineTool({
  name: 'find',
  description: 'List files matching a glob through the workspace filesystem.',
  parameters: FindParams,
  meta: SEARCH_META,
  async execute(args, ctx) {
    const root = args.path ?? ctx.cwd
    const denied = searchPathError(ctx, 'find', root)
    if (denied) return denied
    const report = newWalkReport(),
      re = globToRegExp(args.pattern),
      lines: string[] = [],
      found: FoundPath[] = []
    const limit = args.limit ?? 1000
    let atLimit = false
    for await (const file of walk(ctx, root, report, { maxEntries: 50000 })) {
      if (file.kind !== 'file' || !re.test(file.rel)) continue
      if (lines.length >= limit) {
        atLimit = true
        break
      }
      lines.push(file.rel)
      // Resolved without the workspace fold, which would read a backslash in a name as a separator.
      const abs = isAbsolute(file.abs) ? file.abs : join(ctx.cwd, file.abs)
      found.push({ abs, kind: 'file', rows: [{ row: lines.length - 1, label: file.rel.length }] })
    }
    const failed = !lines.length && report.unreadable > 0
    const text = [
      ...(lines.length ? lines : [failed ? 'nothing could be searched' : 'no matches']),
      ...walkNotes(report, 50000),
      ...(atLimit ? [`[limit ${limit} reached; narrow the search]`] : []),
    ].join('\n')
    if (failed)
      return { ...(await guardedResult(ctx, text)), isError: true, details: { code: 'FS_SEARCH_UNREADABLE' } }
    return referencedResult(ctx, text, lines, found, found.length, atLimit || report.truncated)
  },
})
