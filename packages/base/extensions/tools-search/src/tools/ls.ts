import { defineTool, type FsEntry, type ToolResult } from '@agnes/extension-api'
import { guardOutput, refBlock } from '../../../tools-core/src/guards/output.js'
import { normalizeWorkspacePath } from '../../../tools-core/src/paths.js'
import { HOST_TOOL_FACT_CODEC, hostPathFact } from '../../../tools-core/src/tools/facts.js'
import { LsParams } from '../../../tools-core/src/tools/schemas.js'
import { allowed, SEARCH_META, searchPathError, toolError } from './walk.js'

const DEFAULT_LIMIT = 500

// Every kind the filesystem can report gets its own mark. A symlink shown as an ordinary file hides
// the commonest way a path leads out of the workspace, and a socket or a device shown as a file
// invites a read that will not behave like one.
const MARK: Record<FsEntry['kind'], string> = { file: '', dir: '/', symlink: '@', other: '?' }

export const lsTool = defineTool({
  name: 'ls',
  description:
    'List the entries of a directory. A directory is shown with a trailing slash, a symbolic link with @ and anything else with ?. Entries policy denies are not listed, and the result says how many were left out.',
  parameters: LsParams,
  meta: SEARCH_META,
  async execute(args, ctx): Promise<ToolResult> {
    const dir = args.path ?? ctx.cwd
    const abs = normalizeWorkspacePath(dir, ctx.cwd).abs
    const denied = searchPathError(ctx, 'ls', dir)
    if (denied) return denied
    let entries: FsEntry[]
    try {
      entries = await ctx.fs.list(dir)
    } catch (e) {
      return toolError(`ls failed: ${(e as Error).message}`)
    }
    const kept = entries
      .filter((e) => allowed(ctx, `${abs}/${e.name}`))
      // Code points, not the machine's collation, so the same directory always lists the same way.
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const limit = args.limit ?? DEFAULT_LIMIT
    const visible = kept.slice(0, limit)
    const lines = visible.map((e) => `${e.name}${MARK[e.kind]}`)
    if (kept.length > lines.length) lines.push(`[${kept.length - lines.length} more]`)
    const hidden = entries.length - kept.length
    if (hidden > 0) lines.push(`[${hidden} entries not listed: denied by policy]`)
    // An empty answer is indistinguishable from a broken tool, so an empty directory says so.
    const guarded = await guardOutput(ctx, lines.length > 0 ? lines.join('\n') : '(no entries)')
    const block = { type: 'text' as const, text: guarded.text }
    const resultLimitReached = kept.length > visible.length
    return {
      content: guarded.ref ? [block, refBlock(guarded.ref)] : [block],
      structured: {
        codec: HOST_TOOL_FACT_CODEC,
        tool: 'ls',
        root: hostPathFact(dir, ctx.cwd),
        query: { limit },
        entries: visible.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          path: hostPathFact(`${abs}/${entry.name}`, ctx.cwd).path,
        })),
        coverage: {
          complete: !resultLimitReached && hidden === 0 && !guarded.truncated,
          resultLimitReached,
          outputTruncated: guarded.truncated,
          deniedEntries: hidden,
        },
      },
    }
  },
})
