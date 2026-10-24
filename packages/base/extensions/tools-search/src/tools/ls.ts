import type { FsEntry, ToolResult } from '@agnes/extension-api'
import { defineTool } from '@agnes/plugin-runtime'
import { fsFailure } from '../../../tools-core/src/guards/feedback.js'
import { normalizeWorkspacePath } from '../../../tools-core/src/paths.js'
import { LsParams } from '../../../tools-core/src/tools/schemas.js'
import { type FoundPath, referencedResult } from './references.js'
import { allowed, SEARCH_META, searchPathError } from './walk.js'

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
      return fsFailure(ctx, 'ls', dir, e)
    }
    const kept = entries
      .filter((e) => allowed(ctx, `${abs}/${e.name}`))
      // Code points, not the machine's collation, so the same directory always lists the same way.
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const lines = kept.slice(0, args.limit ?? DEFAULT_LIMIT).map((e) => `${e.name}${MARK[e.kind]}`)
    const shown = lines.length
    if (kept.length > shown) lines.push(`[${kept.length - shown} more; increase limit or narrow path]`)
    const hidden = entries.length - kept.length
    if (hidden > 0) lines.push(`[${hidden} entries not listed: denied by policy]`)
    const rows = lines.slice(0, shown)
    const found = kept.map(
      (e, i): FoundPath => ({
        abs: `${abs}/${e.name}`,
        kind: e.kind === 'dir' ? 'directory' : e.kind,
        ...(i < shown ? { rows: [{ row: i, label: (rows[i] as string).length }] } : {}),
      }),
    )
    // An empty answer is indistinguishable from a broken tool, so an empty directory says so.
    return referencedResult(
      ctx,
      lines.length > 0 ? lines.join('\n') : '(no entries)',
      rows,
      found,
      shown,
      false,
    )
  },
})
